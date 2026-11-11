import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { isBoxName, sshName } from "../../../src/hub/names.ts";

export type LockOptions = { waitMs: number; waiting?(): void };
export type HeldLock = { (): void; during<T>(step: () => Promise<T>): Promise<T> };

export const userWaitMs = 2 * 60_000;
const lockBusy = 75;

export class LockBusy extends Error {}

type Kind = { noun: string; operation: string; folder(home: string): string; file(name: string): string };

export const boxLocks = (home: string) => join(home, ".local/state/fleet/box-locks");
export const peerLocks = (home: string) => join(home, ".local/state/fleet/peer-locks");

const box: Kind = {
  noun: "box",
  operation: "fleet box",
  folder: boxLocks,
  file: (name) => {
    if (!isBoxName(name)) throw new Error(`${name} is not a box, so it has no box lock.`);
    return name;
  },
};
const peer: Kind = { noun: "peer", operation: "fleet peers", folder: peerLocks, file: sshName };

const held = new AsyncLocalStorage<number[]>();
export const heldLocks = (): number[] => held.getStore() ?? [];

function refuseSymlink(kind: Kind, path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Will not lock a ${kind.noun} through a symlink: ${path}`);
}

function openLock(kind: Kind, home: string, name: string): number {
  const file = `${kind.file(name)}.lock`;
  const folder = kind.folder(home);
  refuseSymlink(kind, folder);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  refuseSymlink(kind, folder);
  chmodSync(folder, 0o700);
  const path = join(folder, file);
  refuseSymlink(kind, path);
  try {
    return openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`Will not lock a ${kind.noun} through a symlink: ${path}`);
    throw error;
  }
}

async function flock(fd: number, args: string[]): Promise<{ code: number; stderr: string }> {
  const binary = Bun.which("flock");
  if (!binary) throw new Error("Box operations need flock from util-linux, and this machine has none on PATH.");
  const child = Bun.spawn([binary, ...args, "-E", String(lockBusy), "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { code, stderr };
}

async function lockOne(kind: Kind, home: string, name: string, { waitMs, waiting }: LockOptions): Promise<HeldLock> {
  const fd = openLock(kind, home, name);
  try {
    let locked = await flock(fd, ["-n"]);
    if (locked.code === lockBusy && waitMs > 0) {
      waiting?.();
      locked = await flock(fd, ["-w", String(Math.ceil(waitMs / 1000))]);
    }
    if (locked.code === lockBusy) throw new LockBusy(`${name} is busy: another ${kind.operation} operation on it still runs. Try again in a few minutes.`);
    if (locked.code !== 0) throw new Error(`flock could not lock ${name}: ${locked.stderr.trim()}`);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return Object.assign(() => closeSync(fd), { during: <T>(step: () => Promise<T>) => held.run([...heldLocks(), fd], step) });
}

async function tryLockOne(kind: Kind, home: string, name: string): Promise<HeldLock | undefined> {
  try {
    return await lockOne(kind, home, name, { waitMs: 0 });
  } catch (error) {
    if (error instanceof LockBusy) return undefined;
    throw error;
  }
}

async function withLock<T>(kind: Kind, home: string, name: string, options: LockOptions, step: () => Promise<T>): Promise<T> {
  const unlock = await lockOne(kind, home, name, options);
  try {
    return await unlock.during(step);
  } finally {
    unlock();
  }
}

export const lockBox = (home: string, name: string, options: LockOptions) => lockOne(box, home, name, options);
export const tryLockBox = (home: string, name: string) => tryLockOne(box, home, name);
export const withBoxLock = <T>(home: string, name: string, options: LockOptions, step: () => Promise<T>) => withLock(box, home, name, options, step);
export const tryLockPeer = (home: string, alias: string) => tryLockOne(peer, home, alias);
export const withPeerLock = <T>(home: string, alias: string, options: LockOptions, step: () => Promise<T>) => withLock(peer, home, alias, options, step);
