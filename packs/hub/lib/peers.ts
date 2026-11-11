import { existsSync, lstatSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { LinkedEnvironment } from "../../base/lib/t3/environments.ts";
import { tryLockPeer, userWaitMs, withPeerLock } from "./box-lock.ts";
import { boxMarkerPath, forget, linkTarget, pairWith, readRecord, reviveLink, stopUnit, t3Of, t3Port, type Linker } from "./links.ts";
import { changedFiles, ownedFiles, readIfThere, writeFiles } from "./managed.ts";
import type { PeerMachine } from "./machine.ts";
import { refuseLinks, writePrivateFile } from "../../mcp-gateway/lib/client.ts";
import { isBoxName, sshName } from "./names.ts";

export type PeerLink = Pick<LinkedEnvironment, "environmentId" | "label" | "urls" | "status" | "expiresAt">;
export type PeerHere = Linker & Pick<PeerMachine, "peers" | "devboxes" | "onPeer" | "print">;

const renewWithinMs = 7 * 86_400_000;
const marker = "# Managed by Fleet peer access.";
const usage = "Usage: fleet peers [plan|install|doctor]  Write or check the SSH config that names every peer\n       fleet peers remove|left            Remove the SSH config Fleet wrote, or say whether it is still here\n       fleet peers link [<alias>...]       Link every peer, or the named ones, to T3 here\n       fleet peers renew                   Link each missing peer, and renew each link that expires within 7 days\n       fleet peers restore                 Start each recorded peer forward that does not run";
const peerLinks = (here: Pick<PeerHere, "home">) => join(here.home, ".config/fleet/peer-links");
const recordOf = (here: Pick<PeerHere, "home">, alias: string) => join(peerLinks(here), `${sshName(alias)}.json`);
const guardPeerLinks = (here: Pick<PeerHere, "home">) => refuseLinks(here.home, peerLinks(here), "peer link folder");
export const peerUnitOf = (alias: string) => `fleet-peer-${alias}-t3`;
const isThisABox = (here: Pick<PeerHere, "home">) => !!lstatSync(join(here.home, boxMarkerPath), { throwIfNoEntry: false });

function recordedAliases(here: Pick<PeerHere, "home">): string[] {
  const directory = peerLinks(here);
  return existsSync(directory) ? readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -".json".length)).sort() : [];
}

function holding<T>(here: PeerHere, alias: string, step: () => Promise<T>): Promise<T> {
  return withPeerLock(here.home, alias, { waitMs: userWaitMs, waiting: () => here.say(`${alias}: waiting for another fleet peers operation on it to end`) }, step);
}

async function whenFree(here: PeerHere, alias: string, step: () => Promise<boolean>): Promise<boolean> {
  try {
    const unlock = await tryLockPeer(here.home, alias);
    if (!unlock) return here.say(`${alias}: another fleet peers operation holds it; skipped`), true;
    try {
      return await unlock.during(step);
    } finally {
      unlock();
    }
  } catch (error) {
    here.say((error as Error).message);
    return false;
  }
}

async function startPeerForward(here: PeerHere, unit: string, alias: string, port: number): Promise<void> {
  await stopUnit(here, unit);
  const forward = ["ssh", "-NT", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-L", `127.0.0.1:${port}:127.0.0.1:${t3Port}`, sshName(alias)];
  const started = await here.run(["systemd-run", "--user", "--collect", `--unit=${unit}`, "-p", "Restart=always", "-p", "RestartSec=30", ...forward]);
  if (started.code !== 0) throw new Error(`Cannot start ${unit}: ${started.stderr.trim()}`);
}

export async function unlinkPeer(here: PeerHere, alias: string): Promise<boolean> {
  await guardPeerLinks(here);
  return forget(here, recordOf(here, alias), peerUnitOf(alias));
}

async function linkPeer(here: PeerHere, alias: string): Promise<void> {
  const recorded = readRecord(recordOf(here, alias));
  const urls = recorded ? (linkFor(alias, await linksHere(here), recorded.environmentId)?.urls ?? []) : [];
  if (urls.length) return relink(here, alias, urls);
  if (!(await unlinkPeer(here, alias))) throw new Error(`Unlink the earlier link to ${alias} first.`);
  await pairPeer(here, alias);
}

function pairPeer(here: PeerHere, alias: string): Promise<string> {
  const unit = peerUnitOf(alias);
  return linkTarget(here, { name: alias, record: recordOf(here, alias), unit, forward: (port) => startPeerForward(here, unit, alias, port), onTarget: (command) => here.onPeer(alias, command) });
}

export async function linkPeers(here: PeerHere, aliases: string[] = []): Promise<number> {
  const unknown = aliases.filter((alias) => !here.peers.includes(alias));
  if (unknown.length) throw new Error(`Not a peer of ${here.self}: ${unknown.join(", ")}`);
  await guardPeerLinks(here);
  const failed: string[] = [];
  for (const alias of aliases.length ? aliases : here.peers) {
    try { await holding(here, alias, () => linkPeer(here, alias)); }
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

async function linksHere(here: PeerHere): Promise<PeerLink[]> {
  const listed = await here.run([t3Of(here), "environment", "list", "--json"]);
  if (listed.code !== 0) throw new Error(`Cannot list the linked environments: ${(listed.stderr || listed.stdout).trim()}`);
  return JSON.parse(listed.stdout) as PeerLink[];
}

async function relink(here: PeerHere, alias: string, urls: string[]): Promise<void> {
  await pairWith(here, alias, urls, `Cannot renew the link to ${alias}`, (command) => here.onPeer(alias, command));
  here.say(`renewed the link to ${alias} at ${urls.join(", ")}`);
}

async function forgetLeaver(here: PeerHere, alias: string): Promise<boolean> {
  const record = recordOf(here, alias);
  readRecord(record);
  const unit = peerUnitOf(alias);
  const stopFailure = await stopUnit(here, unit);
  if (stopFailure) {
    here.say(`could not stop ${unit}: ${stopFailure}`);
    return false;
  }
  if (!(await forget(here, record, unit))) return false;
  here.say(`${alias} left the peer list: stopped its forward and forgot its link`);
  return true;
}

function restorePeer(here: PeerHere, alias: string): Promise<boolean> {
  const unit = peerUnitOf(alias);
  return reviveLink(here, recordOf(here, alias), alias, unit, (port) => startPeerForward(here, unit, alias, port));
}

export async function restorePeers(here: PeerHere): Promise<number> {
  await guardPeerLinks(here);
  let failed = 0;
  for (const alias of recordedAliases(here)) {
    const step = here.peers.includes(alias) ? () => restorePeer(here, alias) : () => forgetLeaver(here, alias);
    if (!(await whenFree(here, alias, step))) failed = 1;
  }
  return failed;
}

async function renewPeer(here: PeerHere, alias: string, links: PeerLink[]): Promise<void> {
  const urls = linkFor(alias, links, readRecord(recordOf(here, alias))?.environmentId)?.urls ?? [];
  if (urls.length) await relink(here, alias, urls);
  else await pairPeer(here, alias);
}

export async function renewPeers(here: PeerHere): Promise<number> {
  const restoreFailed = await restorePeers(here);
  const links = await linksHere(here);
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
    try {
      await holding(here, alias, () => renewPeer(here, alias, links));
    } catch (error) {
      here.say(`${alias}: ${(error as Error).message}`);
      failed.push(alias);
    }
  }
  const renewed = due.filter((alias) => !failed.includes(alias)).length;
  here.say(due.length ? `${renewed} of ${due.length} peer links renewed` : "every peer link lasts more than a week");
  const problems = [...(failed.length ? [`not linked: ${failed.join(", ")}`] : []), ...(restoreFailed ? ["a recorded peer forward did not restart, or a peer that left the list kept its link"] : [])];
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

/** Whether Fleet's peer file or its Include line is still here, and with apply, takes both away and keeps the person's own lines. */
export async function removePeerConfig(home: string, apply: boolean): Promise<boolean> {
  const paths = peerPaths(home);
  await refuseLinks(home, paths.config, "SSH config path");
  const owned = await ownedFiles(home, [paths.peers], marker, "SSH config");
  const include = includeOf(paths.peers);
  const lines = ((await readIfThere(paths.config)) ?? "").split("\n");
  const included = lines.includes(include);
  if (apply && owned.length) await rm(paths.peers);
  if (apply && included) await writePrivateFile(paths.config, lines.filter((line) => line !== include).join("\n"));
  return owned.length > 0 || included;
}

export async function peerDoctor(home: string, peers: string[]): Promise<boolean> {
  const paths = peerPaths(home);
  for (const path of [paths.peers, paths.config]) await refuseLinks(home, path, "SSH config path");
  const written = await readIfThere(paths.peers);
  const first = ((await readIfThere(paths.config)) ?? "").split("\n", 1)[0];
  if (written !== peerConfig(peers) || first !== includeOf(paths.peers)) throw new Error("The SSH config does not name every peer. Run fleet peers install.");
  return true;
}

/** Runs remove and left, which need no peer settings, so they work after the hub pack is off. Any other command is undefined. */
export function peerConfigCommand(args: string[], home: string, print: (line: string) => void): Promise<number> | undefined {
  if (args.length !== 1) return undefined;
  if (args[0] === "left") return removePeerConfig(home, false).then((left) => (left ? 0 : 1));
  if (args[0] === "remove") return removePeerConfig(home, true).then(() => (print("Peer access: removed the SSH config Fleet wrote."), 0));
  return undefined;
}

export async function peersCommand(args: string[], here: PeerHere): Promise<number> {
  const [mode = "plan", ...rest] = args;
  if (mode !== "link" && (rest.length || !["plan", "install", "doctor", "renew", "restore", "remove", "left"].includes(mode))) return here.print(usage), 2;
  const config = peerConfigCommand(args, here.home, here.print);
  if (config) return config;
  if (isThisABox(here)) return here.print("This machine is a box. A box has no peers, so fleet peers has nothing to do."), 0;
  for (const box of here.devboxes.filter(isBoxName)) here.say(`${box}: skipped: a box is not a peer`);
  if (mode === "link") return linkPeers(here, rest);
  if (mode === "renew") return renewPeers(here);
  if (mode === "restore") return restorePeers(here);
  if (mode === "doctor") return await peerDoctor(here.home, here.peers), here.print(`Peer access: the SSH config names ${here.peers.join(", ")}`), 0;
  const peers = await installPeerConfig(here.home, here.peers, mode === "install");
  here.print(`Peer access ${mode}: ${peers.join(", ")}`);
  return 0;
}
