import { mkdirSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";

type MemoryTempOptions = { memory: string; pid: number; room?: number };

const gibibyte = 2 ** 30;

export function memoryTemp(env: Record<string, string | undefined>, { memory, pid, room = gibibyte }: MemoryTempOptions): string | undefined {
  try {
    const { bavail, bsize } = statfsSync(memory);
    if (bavail * bsize < room) return undefined;
    const root = join(memory, `fleet-test-${process.getuid?.() ?? "user"}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    removeEndedWorkers(root);
    const dir = join(root, String(pid));
    mkdirSync(dir, { recursive: true });
    env.TMPDIR = dir;
    return dir;
  } catch {
    return undefined;
  }
}

function removeEndedWorkers(root: string) {
  for (const name of readdirSync(root)) if (!running(Number(name))) rmSync(join(root, name), { recursive: true, force: true });
}

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
