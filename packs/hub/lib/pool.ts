import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Hold = { token: string; until: number };
export type Entry = { id: string; claim?: string; hold?: Hold };
export type Pool = { free: string[]; refreshing: string[]; boxes: Record<string, Entry> };
export type Claimed = { box: string; id: string; claim: string };
export type Held = { state: "held"; token: string; claim?: string } | { state: "stale" } | { state: "busy" } | { state: "unowned" };
export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export type PoolClient = {
  own(box: string, id: string): Promise<string>;
  claim(): Promise<Claimed | undefined>;
  hold(box: string, id: string, claim?: string): Promise<Held>;
  renew(box: string, token: string): Promise<boolean>;
  unhold(box: string, token: string): Promise<void>;
  give(box: string, token: string): Promise<boolean>;
  drop(box: string, key: string): Promise<void>;
};

export const holdMs = 30 * 60_000;
const lockStaleMs = 2 * 60_000;
const lockWaitMs = 60_000;
const realClock: Clock = { now: Date.now, sleep: (ms) => Bun.sleep(ms) };

export const poolFile = (home: string) => join(home, ".config/fleet/box-pool.json");

function read(file: string): Pool {
  if (!existsSync(file)) return { free: [], refreshing: [], boxes: {} };
  const pool = JSON.parse(readFileSync(file, "utf8")) as Partial<Pool>;
  return { free: pool.free ?? [], refreshing: pool.refreshing ?? [], boxes: pool.boxes ?? {} };
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

const newId = () => crypto.randomUUID();
const without = (names: string[], box: string) => names.filter((name) => name !== box);
const heldBy = (entry: Entry | undefined, token: string): entry is Entry & { hold: Hold } => entry?.hold?.token === token;

export function own(pool: Pool, box: string, id: string): string {
  const claim = newId();
  pool.boxes[box] = { id, claim };
  return claim;
}

export function claim(pool: Pool): Claimed | undefined {
  for (let box = pool.free.shift(); box; box = pool.free.shift()) {
    const entry = pool.boxes[box];
    if (!entry) continue;
    entry.claim = newId();
    return { box, id: entry.id, claim: entry.claim };
  }
  return undefined;
}

export function hold(pool: Pool, now: number, box: string, id: string, claim?: string): Held {
  const entry = pool.boxes[box];
  if (!entry || entry.id !== id) return { state: "unowned" };
  if (pool.refreshing.includes(box) || (entry.hold && entry.hold.until > now)) return { state: "busy" };
  const free = pool.free.includes(box);
  if (claim !== undefined && (free || entry.claim !== claim)) return { state: "stale" };
  if (free) {
    pool.free = without(pool.free, box);
    entry.claim = newId();
  }
  entry.hold = { token: newId(), until: now + holdMs };
  return { state: "held", token: entry.hold.token, ...(free ? { claim: entry.claim } : {}) };
}

export function renew(pool: Pool, now: number, box: string, token: string): boolean {
  const entry = pool.boxes[box];
  if (!heldBy(entry, token)) return false;
  entry.hold.until = now + holdMs;
  return true;
}

export function unhold(pool: Pool, box: string, token: string): void {
  const entry = pool.boxes[box];
  if (entry?.hold?.token === token) delete entry.hold;
}

export function give(pool: Pool, box: string, token: string, size: number): boolean {
  const entry = pool.boxes[box];
  if (!heldBy(entry, token)) throw new Error(`${box} is no longer held by this release`);
  if (pool.free.length + pool.refreshing.length >= size) return false;
  pool.boxes[box] = { id: entry.id };
  pool.free.push(box);
  return true;
}

export function forget(pool: Pool, box: string): void {
  pool.free = without(pool.free, box);
  pool.refreshing = without(pool.refreshing, box);
  delete pool.boxes[box];
}

export function drop(pool: Pool, box: string, key: string): void {
  const entry = pool.boxes[box];
  if (heldBy(entry, key) || (entry?.claim !== undefined && entry.claim === key)) forget(pool, box);
}

export function poolAt(file: string, size: number, clock: Clock = realClock): PoolClient {
  const change = <T>(step: (pool: Pool, now: number) => T) => withPool(file, (pool) => step(pool, clock.now()), clock);
  return {
    own: (box, id) => change((pool) => own(pool, box, id)),
    claim: () => change(claim),
    hold: (box, id, claimed) => change((pool, now) => hold(pool, now, box, id, claimed)),
    renew: (box, token) => change((pool, now) => renew(pool, now, box, token)),
    unhold: (box, token) => change((pool) => unhold(pool, box, token)),
    give: (box, token) => change((pool) => give(pool, box, token, size)),
    drop: (box, key) => change((pool) => drop(pool, box, key)),
  };
}

export const pooled = (file: string) => {
  const pool = read(file);
  return [...pool.free, ...pool.refreshing];
};

export const recorded = (file: string) => read(file).boxes;
