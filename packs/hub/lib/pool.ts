import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Entry = { id: string; claim?: string; holding?: string };
export type Pool = { free: string[]; refreshing: string[]; boxes: Record<string, Entry> };
export type Claimed = { box: string; id: string; claim: string };
export type Hold = { state: "held"; token: string } | { state: "stale" } | { state: "unowned" };
export type Reserve = { state: "reserved"; claim: string } | { state: "held" } | { state: "busy" };
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

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

const newClaim = () => crypto.randomUUID();
const without = (names: string[], box: string) => names.filter((name) => name !== box);

export const own = (file: string, box: string, id: string) =>
  withPool(file, (pool) => {
    const claim = newClaim();
    pool.boxes[box] = { id, claim };
    return claim;
  });

export const claim = (file: string) =>
  withPool(file, (pool): Claimed | undefined => {
    for (let box = pool.free.shift(); box; box = pool.free.shift()) {
      const entry = pool.boxes[box];
      if (!entry) continue;
      entry.claim = newClaim();
      return { box, id: entry.id, claim: entry.claim };
    }
    return undefined;
  });

export const reserve = (file: string, box: string) =>
  withPool(file, (pool): Reserve => {
    const entry = pool.boxes[box];
    if (pool.refreshing.includes(box) || entry?.holding) return { state: "busy" };
    if (!entry || !pool.free.includes(box)) return { state: "held" };
    pool.free = without(pool.free, box);
    entry.claim = newClaim();
    return { state: "reserved", claim: entry.claim };
  });

export const hold = (file: string, box: string, id: string, claim?: string) =>
  withPool(file, (pool): Hold => {
    const entry = pool.boxes[box];
    if (!entry || entry.id !== id) return { state: "unowned" };
    const free = pool.free.includes(box);
    if (entry.holding || pool.refreshing.includes(box) || (claim !== undefined && (free || entry.claim !== claim))) return { state: "stale" };
    pool.free = without(pool.free, box);
    entry.holding = newClaim();
    return { state: "held", token: entry.holding };
  });

export const unhold = (file: string, box: string, token: string) =>
  withPool(file, (pool) => {
    const entry = pool.boxes[box];
    if (entry?.holding === token) delete entry.holding;
  });

export const give = (file: string, box: string, token: string, size: number) =>
  withPool(file, (pool) => {
    const entry = pool.boxes[box];
    if (!entry || entry.holding !== token) throw new Error(`${box} is no longer held by this release`);
    if (pool.free.length + pool.refreshing.length >= size) return false;
    pool.boxes[box] = { id: entry.id };
    pool.free.push(box);
    return true;
  });

export const drop = (file: string, box: string) =>
  withPool(file, (pool) => {
    pool.free = without(pool.free, box);
    pool.refreshing = without(pool.refreshing, box);
    delete pool.boxes[box];
  });

export const pooled = (file: string) => {
  const pool = read(file);
  return [...pool.free, ...pool.refreshing];
};

export const recorded = (file: string) => read(file).boxes;
