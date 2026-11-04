import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { inside } from "../../files/install.ts";

export type Wait = (ms: number) => Promise<void>;
/** sharedLock: another program takes <file>.lock, a proper-lockfile folder, before it writes the file, so Fleet takes it too and waits with this function. */
export type Write = { target: string; before?: string; after: string; sharedLock?: Wait };

const staleLockMs = 10_000;
const lockTries = 40;
const lockPauseMs = 50;

const lockTarget = ".local/state/fleet/lock";

export async function optional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The first link on the way from home to target, the target included. */
export async function linkOnPath(home: string, target: string): Promise<string | undefined> {
  let path = inside(home, target);
  const root = resolve(home);
  while (path !== root) {
    const info = await lstat(path).catch(() => undefined);
    if (info?.isSymbolicLink()) return path;
    if (info && path !== inside(home, target) && !info.isDirectory()) return path;
    path = dirname(path);
  }
  return undefined;
}

export async function readState(home: string, target: string) {
  await requireRealPath(home, target);
  return optional(inside(home, target));
}

export async function withLock<T>(home: string, work: () => Promise<T>): Promise<T> {
  await requireRealPath(home, lockTarget);
  const lock = inside(home, lockTarget);
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Another Fleet operation holds ${lock}. Remove it only if that operation has stopped.`);
    throw error;
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Writes each file after a backup of its old content. A file that changed since it was read stops the run, and earlier writes roll back. */
export async function writeWithBackups(home: string, writes: Write[]) {
  const backupRoot = `.local/state/fleet/backups/${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const done: Write[] = [];
  try {
    for (const write of writes) {
      await requireRealPath(home, write.target);
      const path = inside(home, write.target);
      if (write.before !== undefined) {
        const backup = `${backupRoot}/${write.target}`;
        await requireRealPath(home, backup);
        await mkdir(dirname(inside(home, backup)), { recursive: true, mode: 0o700 });
        await requireRealPath(home, backup);
        await writeFile(inside(home, backup), write.before, { mode: 0o600, flag: "wx" });
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, write.after, { mode: 0o600, flag: "wx" });
      try {
        await requireRealPath(home, write.target);
        await holdingSharedLock(write, path, async () => {
          if ((await optional(path)) !== write.before) throw new Error(`${write.target} changed while Fleet was applying. Run fleet apply again.`);
          await rename(temporary, path);
        });
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      done.push(write);
    }
  } catch (error) {
    for (const write of done.reverse()) await restore(home, write);
    throw error;
  }
}

async function requireRealPath(home: string, target: string) {
  const link = await linkOnPath(home, target);
  if (link) throw new Error(`${link} is a link or not a directory; Fleet writes only through real directories`);
}

async function restore(home: string, write: Write) {
  if (await linkOnPath(home, write.target)) return;
  const path = inside(home, write.target);
  await holdingSharedLock(write, path, async () => {
    if ((await optional(path)) !== write.after) return;
    if (write.before === undefined) return void (await rm(path, { force: true }));
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, write.before, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  });
}

/** Takes the lock the way proper-lockfile does: the folder <file>.lock, which its holder refreshes, so one older than ten seconds is left over from a crash. */
async function holdingSharedLock(write: Write, path: string, work: () => Promise<void>) {
  if (!write.sharedLock) return work();
  const lock = `${path}.lock`;
  for (let tries = 0; ; tries++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lock).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > staleLockMs) await rm(lock, { recursive: true, force: true });
      else if (tries >= lockTries) throw new Error(`${write.target} stays locked by another program, such as Claude Code saving it. Run fleet apply again.`);
      else await write.sharedLock(lockPauseMs);
    }
  }
  try {
    await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
