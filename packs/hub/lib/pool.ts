import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Hold = { token: string; until: number };
export type Entry = { id: string; claim?: string; hold?: Hold };
export type Pool = { free: string[]; refreshing: string[]; boxes: Record<string, Entry> };
export type Owned = { claim: string; token: string };
export type Claimed = Owned & { box: string; id: string };
export type Held = { state: "held"; token: string; claim?: string } | { state: "stale" } | { state: "busy" } | { state: "unowned" };
export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export type PoolClient = {
  own(box: string, id: string): Promise<Owned>;
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

const newHold = (now: number): Hold => ({ token: newId(), until: now + holdMs });

export function own(pool: Pool, now: number, box: string, id: string): Owned {
  const entry = { id, claim: newId(), hold: newHold(now) };
  pool.boxes[box] = entry;
  return { claim: entry.claim, token: entry.hold.token };
}

export function claim(pool: Pool, now: number): Claimed | undefined {
  for (let box = pool.free.shift(); box; box = pool.free.shift()) {
    const entry = pool.boxes[box];
    if (!entry) continue;
    const owned = { claim: newId(), hold: newHold(now) };
    Object.assign(entry, owned);
    return { box, id: entry.id, claim: owned.claim, token: owned.hold.token };
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
  entry.hold = newHold(now);
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
    own: (box, id) => change((pool, now) => own(pool, now, box, id)),
    claim: () => change(claim),
    hold: (box, id, claimed) => change((pool, now) => hold(pool, now, box, id, claimed)),
    renew: (box, token) => change((pool, now) => renew(pool, now, box, token)),
    unhold: (box, token) => change((pool) => unhold(pool, box, token)),
    give: (box, token) => change((pool) => give(pool, box, token, size)),
    drop: (box, key) => change((pool) => drop(pool, box, key)),
  };
}

export class HoldLost extends Error {}
export type Holder = { held: boolean; renew(): Promise<void>; give(): Promise<boolean>; drop(): Promise<void> };
const unheld: Holder = { held: false, renew: async () => {}, give: async () => false, drop: async () => {} };

export async function withHold<T>(pool: PoolClient | undefined, box: string, token: string | undefined, step: (holder: Holder) => Promise<T>): Promise<T> {
  if (!pool || token === undefined) return step(unheld);
  let holding = true;
  const holder: Holder = {
    held: true,
    renew: async () => {
      if (await pool.renew(box, token)) return;
      holding = false;
      throw new HoldLost(`another operation took ${box} over while this one held it, so this one stopped before it changed the box`);
    },
    give: async () => {
      const given = await pool.give(box, token);
      holding = !given;
      return given;
    },
    drop: async () => {
      await pool.drop(box, token);
      holding = false;
    },
  };
  try {
    return await step(holder);
  } finally {
    if (holding) await pool.unhold(box, token).catch(() => undefined);
  }
}

export const pooled = (file: string) => {
  const pool = read(file);
  return [...pool.free, ...pool.refreshing];
};

export const recorded = (file: string) => read(file).boxes;
