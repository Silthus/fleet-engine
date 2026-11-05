import { join } from "node:path";
import type { LinkedEnvironment } from "../../base/lib/t3/environments.ts";
import { forget, linkTarget, pairWith, readRecord, restoreRecorded, stopUnit, t3Of, t3Port, type Linker } from "./links.ts";
import { changedFiles, readIfThere, writeFiles } from "./managed.ts";
import type { PeerMachine } from "./machine.ts";
import { refuseLinks, writePrivateFile } from "./mcphub/client.ts";
import { sshName } from "./run.ts";

export type PeerLink = Pick<LinkedEnvironment, "environmentId" | "label" | "urls" | "status" | "expiresAt">;
export type PeerHere = Linker & Pick<PeerMachine, "peers" | "onPeer" | "print">;

const renewWithinMs = 7 * 86_400_000;
export const peerPairLimitMs = 60_000;
const marker = "# Managed by Fleet peer access.";
const usage = "Usage: fleet peers [plan|install|doctor]  Write or check the SSH config that names every peer\n       fleet peers link [<alias>...]       Link every peer, or the named ones, to T3 here\n       fleet peers renew                   Link each missing peer, and renew each link that expires within 7 days\n       fleet peers restore                 Start each recorded peer forward that does not run";
const peerLinks = (here: Pick<PeerHere, "home">) => join(here.home, ".config/fleet/peer-links");
const recordOf = (here: Pick<PeerHere, "home">, alias: string) => join(peerLinks(here), `${sshName(alias)}.json`);
const guardPeerLinks = (here: Pick<PeerHere, "home">) => refuseLinks(here.home, peerLinks(here), "peer link folder");
export const peerUnitOf = (alias: string) => `fleet-peer-${alias}-t3`;

function startPeerForward(here: PeerHere, unit: string, alias: string, port: number): void {
  stopUnit(here, unit);
  const forward = ["ssh", "-NT", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-L", `127.0.0.1:${port}:127.0.0.1:${t3Port}`, sshName(alias)];
  const started = here.run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "-p", "Restart=always", "-p", "RestartSec=30", ...forward]);
  if (started.code !== 0) throw new Error(`Cannot start ${unit}: ${started.stderr.trim()}`);
}

export async function unlinkPeer(here: PeerHere, alias: string): Promise<boolean> {
  await guardPeerLinks(here);
  return forget(here, recordOf(here, alias), peerUnitOf(alias));
}

async function linkPeer(here: PeerHere, alias: string): Promise<string> {
  if (!(await unlinkPeer(here, alias))) throw new Error(`Unlink the earlier link to ${alias} first.`);
  return pairPeer(here, alias);
}

function pairPeer(here: PeerHere, alias: string): Promise<string> {
  const unit = peerUnitOf(alias);
  return linkTarget(here, { name: alias, record: recordOf(here, alias), unit, forward: (port) => startPeerForward(here, unit, alias, port), onTarget: (command) => here.onPeer(alias, command, undefined, peerPairLimitMs) });
}

export async function linkPeers(here: PeerHere, aliases: string[] = []): Promise<number> {
  const unknown = aliases.filter((alias) => !here.peers.includes(alias));
  if (unknown.length) throw new Error(`Not a peer of ${here.self}: ${unknown.join(", ")}`);
  await guardPeerLinks(here);
  const failed: string[] = [];
  for (const alias of aliases.length ? aliases : here.peers) {
    try { await linkPeer(here, alias); }
    catch (error) { here.say(`${alias}: ${(error as Error).message}`); failed.push(alias); }
  }
  if (failed.length) here.say(`not linked: ${failed.join(", ")}`);
  return failed.length ? 1 : 0;
}

export function linkFor(alias: string, links: PeerLink[], recordedId?: string): PeerLink | undefined {
  return recordedId ? links.find((link) => link.environmentId === recordedId) : links.find((link) => link.label === alias);
}

export function peersToRenew(peers: string[], links: PeerLink[], now: number, recorded: Record<string, string> = {}): string[] {
  return peers.filter((alias) => {
    const linked = linkFor(alias, links, recorded[alias]);
    return !linked || linked.status === "expired" || Date.parse(linked.expiresAt) - now < renewWithinMs;
  });
}

function linksHere(here: PeerHere): PeerLink[] {
  const listed = here.run([t3Of(here), "environment", "list", "--json"]);
  if (listed.code !== 0) throw new Error(`Cannot list the linked environments: ${(listed.stderr || listed.stdout).trim()}`);
  return JSON.parse(listed.stdout) as PeerLink[];
}

async function relink(here: PeerHere, alias: string, urls: string[]): Promise<void> {
  await pairWith(here, alias, urls, `Cannot renew the link to ${alias}`, (command) => here.onPeer(alias, command, undefined, peerPairLimitMs));
  here.say(`renewed the link to ${alias} at ${urls.join(", ")}`);
}

export async function restorePeers(here: PeerHere): Promise<number> {
  await guardPeerLinks(here);
  return restoreRecorded(here, peerLinks(here), peerUnitOf, (alias, unit, port) => startPeerForward(here, unit, alias, port));
}

export async function renewPeers(here: PeerHere): Promise<number> {
  const restoreFailed = await restorePeers(here);
  const links = linksHere(here);
  const failed: string[] = [];
  const recorded: Record<string, string> = {};
  const readable = here.peers.filter((alias) => {
    try {
      const record = readRecord(recordOf(here, alias));
      if (record) recorded[alias] = record.environmentId;
      return true;
    } catch (error) {
      here.say(`${alias}: ${(error as Error).message}`);
      failed.push(alias);
      return false;
    }
  });
  const due = peersToRenew(readable, links, here.now(), recorded);
  for (const alias of due) {
    const urls = linkFor(alias, links, recorded[alias])?.urls ?? [];
    try {
      if (urls.length) await relink(here, alias, urls);
      else await pairPeer(here, alias);
    } catch (error) {
      here.say(`${alias}: ${(error as Error).message}`);
      failed.push(alias);
    }
  }
  const renewed = due.filter((alias) => !failed.includes(alias)).length;
  here.say(due.length ? `${renewed} of ${due.length} peer links renewed` : "every peer link lasts more than a week");
  const problems = [...(failed.length ? [`not linked: ${failed.join(", ")}`] : []), ...(restoreFailed ? ["a recorded peer forward did not restart"] : [])];
  if (problems.length) here.say(problems.join("; "));
  return problems.length ? 1 : 0;
}

export function peerConfig(peers: string[]): string {
  const hosts = peers.length ? `Host ${peers.map(sshName).join(" ")}\n  ForwardAgent no\n  ServerAliveInterval 30\n  ServerAliveCountMax 3\n` : "";
  return `${marker}\n${hosts}`;
}

const peerPaths = (home: string) => ({ peers: join(home, ".ssh/fleet-peers.conf"), config: join(home, ".ssh/config") });
const includeOf = (peersPath: string) => `Include "${peersPath}"`;

export async function installPeerConfig(home: string, peers: string[], apply: boolean): Promise<string[]> {
  const paths = peerPaths(home);
  const changed = await changedFiles(home, [{ path: paths.peers, content: peerConfig(peers) }], marker, "SSH config");
  await refuseLinks(home, paths.config, "SSH config path");
  if (!apply) return peers;
  await writeFiles(changed);
  const include = includeOf(paths.peers);
  const previous = (await readIfThere(paths.config)) ?? "";
  const config = `${include}\n${previous.split("\n").filter((line) => line !== include).join("\n")}`;
  if (config !== previous) await writePrivateFile(paths.config, config);
  return peers;
}

export async function peerDoctor(home: string, peers: string[]): Promise<boolean> {
  const paths = peerPaths(home);
  for (const path of [paths.peers, paths.config]) await refuseLinks(home, path, "SSH config path");
  const written = await readIfThere(paths.peers);
  const first = ((await readIfThere(paths.config)) ?? "").split("\n", 1)[0];
  if (written !== peerConfig(peers) || first !== includeOf(paths.peers)) throw new Error("The SSH config does not name every peer. Run fleet peers install.");
  return true;
}

export async function peersCommand(args: string[], here: PeerHere): Promise<number> {
  const [mode = "plan", ...rest] = args;
  if (mode === "link") return linkPeers(here, rest);
  if (rest.length || !["plan", "install", "doctor", "renew", "restore"].includes(mode)) return here.print(usage), 2;
  if (mode === "renew") return renewPeers(here);
  if (mode === "restore") return restorePeers(here);
  if (mode === "doctor") return await peerDoctor(here.home, here.peers), here.print(`Peer access: the SSH config names ${here.peers.join(", ")}`), 0;
  const peers = await installPeerConfig(here.home, here.peers, mode === "install");
  here.print(`Peer access ${mode}: ${peers.join(", ")}`);
  return 0;
}
