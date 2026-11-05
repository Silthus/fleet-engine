import { join } from "node:path";
import type { LinkedEnvironment } from "../../base/lib/t3/environments.ts";
import { forget, linkTarget, pairCommand, restoreRecorded, stopUnit, t3Of, t3Port, type Linker } from "./links.ts";
import { changedFiles, readIfThere, writeFiles } from "./managed.ts";
import type { PeerMachine } from "./machine.ts";
import { refuseLinks, writePrivateFile } from "./mcphub/client.ts";
import { sshName } from "./run.ts";

export type PeerLink = Pick<LinkedEnvironment, "label" | "urls" | "status" | "expiresAt">;
export type PeerHere = Linker & Pick<PeerMachine, "peers" | "onPeer" | "print">;

const renewWithinMs = 7 * 86_400_000;
const marker = "# Managed by Fleet peer access.";
const usage = "Usage: fleet peers [plan|install]      Write the SSH config that names every peer\n       fleet peers link [<alias>...]     Link every peer, or the named ones, to T3 here\n       fleet peers renew                 Link each missing peer, and renew each link that expires within 7 days";
const peerLinks = (here: Pick<PeerHere, "home">) => join(here.home, ".config/fleet/peer-links");
export const peerUnitOf = (alias: string) => `fleet-peer-${alias}-t3`;

function startPeerForward(here: PeerHere, unit: string, alias: string, port: number): void {
  stopUnit(here, unit);
  const forward = ["ssh", "-NT", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-L", `127.0.0.1:${port}:127.0.0.1:${t3Port}`, sshName(alias)];
  const started = here.run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "-p", "Restart=always", "-p", "RestartSec=30", ...forward]);
  if (started.code !== 0) throw new Error(`Cannot start ${unit}: ${started.stderr.trim()}`);
}

export function unlinkPeer(here: PeerHere, alias: string): boolean {
  return forget(here, join(peerLinks(here), `${sshName(alias)}.json`), peerUnitOf(alias));
}

async function linkPeer(here: PeerHere, alias: string): Promise<string> {
  if (!unlinkPeer(here, alias)) throw new Error(`Unlink the earlier link to ${alias} first.`);
  const unit = peerUnitOf(alias);
  return linkTarget(here, { name: alias, record: join(peerLinks(here), `${alias}.json`), unit, forward: (port) => startPeerForward(here, unit, alias, port), onTarget: (command) => here.onPeer(alias, command) });
}

export async function linkPeers(here: PeerHere, aliases: string[] = []): Promise<number> {
  const unknown = aliases.filter((alias) => !here.peers.includes(alias));
  if (unknown.length) throw new Error(`Not a peer of ${here.self}: ${unknown.join(", ")}`);
  const failed: string[] = [];
  for (const alias of aliases.length ? aliases : here.peers) {
    try { await linkPeer(here, alias); }
    catch (error) { here.say(`${alias}: ${(error as Error).message}`); failed.push(alias); }
  }
  if (failed.length) here.say(`not linked: ${failed.join(", ")}`);
  return failed.length ? 1 : 0;
}

export function peersToRenew(peers: string[], links: PeerLink[], now: number): string[] {
  return peers.filter((alias) => {
    const linked = links.find((link) => link.label === alias);
    return !linked || linked.status === "expired" || Date.parse(linked.expiresAt) - now < renewWithinMs;
  });
}

function linksHere(here: PeerHere): PeerLink[] {
  const listed = here.run([t3Of(here), "environment", "list", "--json"]);
  if (listed.code !== 0) throw new Error(`Cannot list the linked environments: ${(listed.stderr || listed.stdout).trim()}`);
  return JSON.parse(listed.stdout) as PeerLink[];
}

function relink(here: PeerHere, alias: string, urls: string[]): void {
  const code = here.onPeer(alias, pairCommand(here)).stdout.trim();
  if (!code) throw new Error(`${alias} did not issue a pairing code.`);
  const alternates = urls.slice(1).flatMap((url) => ["--url", url]);
  const linked = here.run([t3Of(here), "environment", "link", urls[0]!, ...alternates, "--pairing-code", code, "--access", "full-access"]);
  if (linked.code !== 0) throw new Error(`Cannot renew the link to ${alias}: ${(linked.stderr || linked.stdout).trim()}`);
  here.say(`renewed the link to ${alias} at ${urls.join(", ")}`);
}

export async function renewPeers(here: PeerHere): Promise<number> {
  restoreRecorded(here, peerLinks(here), peerUnitOf, (alias, unit, port) => startPeerForward(here, unit, alias, port));
  const links = linksHere(here);
  const due = peersToRenew(here.peers, links, here.now());
  const failed: string[] = [];
  for (const alias of due) {
    const urls = links.find((link) => link.label === alias)?.urls ?? [];
    try {
      if (urls.length) relink(here, alias, urls);
      else await linkPeer(here, alias);
    } catch (error) {
      here.say(`${alias}: ${(error as Error).message}`);
      failed.push(alias);
    }
  }
  here.say(due.length ? `${due.length - failed.length} of ${due.length} peer links renewed` : "every peer link lasts more than a week");
  if (failed.length) here.say(`not linked: ${failed.join(", ")}`);
  return failed.length ? 1 : 0;
}

export function peerConfig(peers: string[]): string {
  const hosts = peers.length ? `Host ${peers.map(sshName).join(" ")}\n  ForwardAgent no\n  ServerAliveInterval 30\n  ServerAliveCountMax 3\n` : "";
  return `${marker}\n${hosts}`;
}

export async function installPeerConfig(home: string, peers: string[], apply: boolean): Promise<string[]> {
  const peersPath = join(home, ".ssh/fleet-peers.conf");
  const configPath = join(home, ".ssh/config");
  const changed = await changedFiles(home, [{ path: peersPath, content: peerConfig(peers) }], marker, "SSH config");
  await refuseLinks(home, configPath, "SSH config path");
  if (!apply) return peers;
  await writeFiles(changed);
  const include = `Include "${peersPath}"`;
  const previous = (await readIfThere(configPath)) ?? "";
  const config = `${include}\n${previous.split("\n").filter((line) => line !== include).join("\n")}`;
  if (config !== previous) await writePrivateFile(configPath, config);
  return peers;
}

export async function peersCommand(args: string[], here: PeerHere): Promise<number> {
  const [mode = "plan", ...rest] = args;
  if (mode === "link") return linkPeers(here, rest);
  if (rest.length || !["plan", "install", "renew"].includes(mode)) return here.print(usage), 2;
  if (mode === "renew") return renewPeers(here);
  const peers = await installPeerConfig(here.home, here.peers, mode === "install");
  here.print(`Peer access ${mode}: ${peers.join(", ")}`);
  return 0;
}
