import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Pool = { free: string[]; refreshing: string[] };
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

const lockStaleMs = 2 * 60_000;
const lockWaitMs = 60_000;
const realClock: Clock = { now: Date.now, sleep: (ms) => Bun.sleep(ms) };

export const poolFile = (home: string) => join(home, ".config/fleet/box-pool.json");

function read(file: string): Pool {
  if (!existsSync(file)) return { free: [], refreshing: [] };
  const pool = JSON.parse(readFileSync(file, "utf8")) as Partial<Pool>;
  return { free: pool.free ?? [], refreshing: pool.refreshing ?? [] };
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
    const temporary = `${file}.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(pool, null, 2)}\n`);
    renameSync(temporary, file);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export const claim = (file: string) => withPool(file, (pool) => pool.free.shift());

export const give = (file: string, box: string, size: number) =>
  withPool(file, (pool) => {
    if (pool.free.includes(box) || pool.refreshing.includes(box)) return true;
    if (pool.free.length + pool.refreshing.length >= size) return false;
    pool.free.push(box);
    return true;
  });

export const drop = (file: string, box: string) =>
  withPool(file, (pool) => {
    pool.free = pool.free.filter((name) => name !== box);
    pool.refreshing = pool.refreshing.filter((name) => name !== box);
  });

export const pooled = (file: string) => {
  const pool = read(file);
  return [...pool.free, ...pool.refreshing];
};
