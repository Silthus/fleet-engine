import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type Held = { release(): void };

const exclusive = 2;
const noWait = 4;
const pollMs = 250;

let libc: ReturnType<typeof openLibc> | undefined;

function openLibc() {
  return dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
}

/**
 * Takes an exclusive flock on the file at path without waiting, and writes the time it took it.
 * The kernel drops the lock when its process ends, so a dead holder never blocks the next run.
 */
export function tryLock(path: string, now: number): Held | undefined {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  libc ??= openLibc();
  if (libc.symbols.flock(fd, exclusive | noWait) !== 0) {
    closeSync(fd);
    return undefined;
  }
  ftruncateSync(fd, 0);
  writeSync(fd, String(now), 0);
  return {
    release() {
      ftruncateSync(fd, 0);
      closeSync(fd);
    },
  };
}

/** Waits up to limitMs for the lock, asking sleep for each pause. */
export async function waitLock(path: string, now: () => number, sleep: (ms: number) => Promise<void>, limitMs: number): Promise<Held | undefined> {
  for (let waited = 0; ; waited += pollMs) {
    const held = tryLock(path, now());
    if (held || waited >= limitMs) return held;
    await sleep(pollMs);
  }
}

/** The time the current holder took the lock, as it wrote it. */
export function lockedSince(path: string): number | undefined {
  const text = (() => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return "";
    }
  })();
  const at = Number(text);
  return text && Number.isFinite(at) ? at : undefined;
}
