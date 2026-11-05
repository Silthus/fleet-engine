import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Leaving = "pool" | "delete";
export type Entry = { id: string; claim?: string; claiming?: true; leaving?: Leaving };
export type Pool = { free: string[]; boxes: Record<string, Entry> };
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

const lockStaleMs = 2 * 60_000;
const lockWaitMs = 60_000;
const realClock: Clock = { now: Date.now, sleep: (ms) => Bun.sleep(ms) };

export const poolFile = (home: string) => join(home, ".config/fleet/box-pool.json");

function entryOf(raw: Entry): Entry {
  return { id: raw.id, ...(raw.claim === undefined ? {} : { claim: raw.claim }), ...(raw.claiming ? { claiming: true as const } : {}), ...(raw.leaving ? { leaving: raw.leaving } : {}) };
}

function read(file: string): Pool {
  if (!existsSync(file)) return { free: [], boxes: {} };
  const raw = JSON.parse(readFileSync(file, "utf8")) as { free?: string[]; refreshing?: string[]; boxes?: Record<string, Entry> };
  const boxes = Object.fromEntries(Object.entries(raw.boxes ?? {}).map(([box, entry]) => [box, entryOf(entry)]));
  const free = [...new Set([...(raw.free ?? []), ...(raw.refreshing ?? [])])].filter((box) => boxes[box] && boxes[box].claim === undefined);
  return { free, boxes };
}

export async function withPool<T>(file: string, change: (pool: Pool) => T, clock: Clock = realClock): Promise<T> {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = clock.now() + lockWaitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (clock.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? clock.now()) > lockStaleMs) rmSync(lock, { recursive: true, force: true });
      else if (clock.now() > deadline) throw new Error(`The box pool stayed locked for a minute: ${lock}`);
      else await clock.sleep(100);
    }
  }
  try {
    const pool = read(file);
    const result = change(pool);
    const temporary = `${file}.${crypto.randomUUID()}.partial`;
    writeFileSync(temporary, `${JSON.stringify(pool, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, file);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const newClaim = () => crypto.randomUUID();
const without = (names: string[], box: string) => names.filter((name) => name !== box);
const entryFor = (pool: Pool, box: string, id: string) => (pool.boxes[box]?.id === id ? pool.boxes[box] : undefined);

export function record(pool: Pool, box: string, id: string): string {
  const claim = newClaim();
  pool.free = without(pool.free, box);
  pool.boxes[box] = { id, claim, claiming: true };
  return claim;
}

export function take(pool: Pool, box: string): { id: string; claim: string } | undefined {
  const entry = pool.boxes[box];
  if (!entry || !pool.free.includes(box)) return undefined;
  pool.free = without(pool.free, box);
  entry.claim = newClaim();
  entry.claiming = true;
  return { id: entry.id, claim: entry.claim };
}

export function settle(pool: Pool, box: string, id: string): void {
  const entry = entryFor(pool, box, id);
  if (entry) delete entry.claiming;
}

export function leave(pool: Pool, box: string, id: string, how: Leaving): void {
  const entry = entryFor(pool, box, id);
  if (entry) entry.leaving = how;
}

export function stay(pool: Pool, box: string, id: string): void {
  const entry = entryFor(pool, box, id);
  if (entry) delete entry.leaving;
}

export function giveBack(pool: Pool, box: string, id: string, size: number): boolean {
  if (!entryFor(pool, box, id) || pool.free.length >= size) return false;
  pool.boxes[box] = { id };
  pool.free.push(box);
  return true;
}

export function forget(pool: Pool, box: string, id: string): void {
  if (!entryFor(pool, box, id)) return;
  pool.free = without(pool.free, box);
  delete pool.boxes[box];
}

export const pooled = (file: string) => read(file).free;

export const recorded = (file: string) => read(file).boxes;
