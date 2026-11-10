import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Env, Result } from "../coder.ts";
import { peersOf, quote, remoteFleet } from "../machine.ts";
import { readSeen, unreachedPath, type Unreached } from "./analyze.ts";
import { digestLines, memoryCheckout, parseSince, stateDir, type Digest } from "./digest.ts";

export type DreamBoxes = { running(): Promise<string[]>; ssh(box: string, command: string): Promise<Result> };
export type CollectIo = {
  home: string; env: Env; self: string; now(): number; peers: string[];
  onPeer(alias: string, command: string): Promise<Result>;
  boxes(): DreamBoxes | undefined;
  git(args: string[]): Promise<Result>;
  say(line: string): void;
};

const day = 86_400_000;
export const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export function dreamPeers(hub: string, devboxes: string[], self: string): string[] {
  return peersOf(hub, devboxes, self).filter((alias) => alias !== hub);
}

function parseDigests(text: string, source: string, say: (line: string) => void): Digest[] {
  const found: Digest[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { found.push(JSON.parse(line)); } catch { say(`Fleet dream: skipped a broken digest line from ${source}`); }
  }
  return found;
}

export function unseenPart(item: Digest, seen: Record<string, string>): Digest | undefined {
  const after = seen[`${item.provider}:${item.session}`] ?? "";
  const entries = item.entries.filter((entry) => entry.at > after);
  if (!entries.some((entry) => entry.role === "user")) return undefined;
  return { ...item, entries };
}

async function gather(since: number, io: CollectIo) {
  const remote = remoteFleet(`dream digest --since ${quote(new Date(since).toISOString())}`);
  const gathered = parseDigests(digestLines(io.home, io.self, since, io.now(), io.env), io.self, io.say);
  const failed: string[] = [];
  const unreached: Unreached[] = [];
  for (const alias of io.peers) {
    const answer = await io.onPeer(alias, remote);
    if (answer.code === 0) gathered.push(...parseDigests(answer.stdout, alias, io.say));
    else {
      failed.push(`${alias} (exit ${answer.code}: ${answer.stderr.trim().split("\n").pop()})`);
      unreached.push({ machine: alias, reason: `exit ${answer.code}` });
    }
  }
  try {
    const boxes = io.boxes();
    for (const box of (await boxes?.running()) ?? []) {
      const answer = await boxes!.ssh(box, `bash -lc ${quote(remote)}`);
      if (answer.code === 0) gathered.push(...parseDigests(answer.stdout, box, io.say));
      else {
        failed.push(`${box} (exit ${answer.code})`);
        unreached.push({ machine: box, reason: `exit ${answer.code}` });
      }
    }
  } catch (error) {
    failed.push(`boxes (${(error as Error).message})`);
    unreached.push({ machine: "boxes", reason: "could not list them" });
  }
  return { gathered, failed, unreached };
}

export async function collect(since: string, io: CollectIo): Promise<string> {
  const { gathered, failed, unreached } = await gather(parseSince(since, io.now()), io);
  const state = stateDir(io.home, io.env);
  const seen = readSeen(state);
  const newest = new Map<string, Digest>();
  for (const item of gathered) {
    const key = `${item.provider}:${item.session}`;
    if ((newest.get(key)?.endedAt ?? "") <= item.endedAt) newest.set(key, item);
  }
  const run = join(state, dateOf(io.now()));
  mkdirSync(join(run, "digests"), { recursive: true, mode: 0o700 });
  writeFileSync(unreachedPath(run), JSON.stringify(unreached), { mode: 0o600 });
  const usagePath = join(state, "usage.json");
  const usage: Record<string, string> = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : {};
  let kept = 0;
  for (const item of newest.values()) {
    for (const path of [...item.memoryReads, ...item.memoryWrites, ...(item.memoryShown ?? [])]) if ((usage[path] ?? "") < item.endedAt) usage[path] = item.endedAt;
    const fresh = unseenPart(item, seen);
    if (!fresh) continue;
    const name = `${item.machine}-${item.provider}-${item.session.slice(0, 8)}-${item.endedAt.replace(/\D/g, "").slice(0, 14)}.json`;
    const prefix = name.slice(0, name.lastIndexOf("-"));
    for (const older of readdirSync(join(run, "digests"))) {
      if (older !== name && older.startsWith(`${prefix}-`) && !existsSync(join(run, "findings", older))) rmSync(join(run, "digests", older));
    }
    writeFileSync(join(run, "digests", name), JSON.stringify(fresh), { mode: 0o600 });
    kept++;
  }
  writeFileSync(usagePath, JSON.stringify(usage, null, 1));
  const oldest = dateOf(io.now() - 14 * day);
  for (const old of readdirSync(state).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && name < oldest)) rmSync(join(state, old), { recursive: true, force: true });
  await io.git(["-C", memoryCheckout(io.home, io.env), "worktree", "prune"]);
  io.say(`Fleet dream: ${gathered.length} sessions read, ${kept} new in ${run}.${failed.length ? ` Not reached: ${failed.join("; ")}.` : ""}`);
  return run;
}
