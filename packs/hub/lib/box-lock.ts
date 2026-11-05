import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

export type LockOptions = { waitMs: number; waiting?(): void };
export type HeldLock = { (): void; during<T>(step: () => Promise<T>): Promise<T> };

export const userWaitMs = 2 * 60_000;
const lockBusy = 75;

export class BoxBusy extends Error {}

export const boxLocks = (home: string) => join(home, ".local/state/fleet/box-locks");

const held = new AsyncLocalStorage<number[]>();
export const heldLocks = (): number[] => held.getStore() ?? [];

function refuseSymlink(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Will not lock a box through a symlink: ${path}`);
}

function openLock(home: string, box: string): number {
  if (!/^box-[a-z0-9][a-z0-9-]*$/.test(box)) throw new Error(`${box} is not a box, so it has no box lock.`);
  const folder = boxLocks(home);
  refuseSymlink(folder);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  refuseSymlink(folder);
  chmodSync(folder, 0o700);
  const path = join(folder, `${box}.lock`);
  refuseSymlink(path);
  try {
    return openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`Will not lock a box through a symlink: ${path}`);
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

export async function lockBox(home: string, box: string, { waitMs, waiting }: LockOptions): Promise<HeldLock> {
  const fd = openLock(home, box);
  try {
    let locked = await flock(fd, ["-n"]);
    if (locked.code === lockBusy && waitMs > 0) {
      waiting?.();
      locked = await flock(fd, ["-w", String(Math.ceil(waitMs / 1000))]);
    }
    if (locked.code === lockBusy) throw new BoxBusy(`${box} is busy: another fleet box operation on it still runs. Try again in a few minutes.`);
    if (locked.code !== 0) throw new Error(`flock could not lock ${box}: ${locked.stderr.trim()}`);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return Object.assign(() => closeSync(fd), { during: <T>(step: () => Promise<T>) => held.run([...heldLocks(), fd], step) });
}

export async function withBoxLock<T>(home: string, box: string, options: LockOptions, step: () => Promise<T>): Promise<T> {
  const unlock = await lockBox(home, box, options);
  try {
    return await unlock.during(step);
  } finally {
    unlock();
  }
}
