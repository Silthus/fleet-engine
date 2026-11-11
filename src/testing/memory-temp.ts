import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";

type MemoryTempOptions = { memory: string; pid: number; room?: number; mounts?: string };

const gibibyte = 2 ** 30;

export function memoryTemp(env: Record<string, string | undefined>, { memory, pid, room = gibibyte, mounts = "/proc/self/mounts" }: MemoryTempOptions): string | undefined {
  try {
    if (mountedNoexec(memory, readFileSync(mounts, "utf8"))) return undefined;
    const root = ownRoot(memory);
    if (!root) return undefined;
    removeEndedWorkers(root);
    const { bavail, bsize } = statfsSync(memory);
    if (bavail * bsize < room) return undefined;
    const dir = join(root, String(pid));
    mkdirSync(dir, { recursive: true });
    env.TMPDIR = dir;
    return dir;
  } catch {
    return undefined;
  }
}

function mountedNoexec(path: string, mounts: string) {
  let covering: { point: string; options: string[] } | undefined;
  for (const [, escaped, , options] of mounts.split("\n").map((line) => line.split(" "))) {
    if (escaped === undefined || options === undefined) continue;
    const point = escaped.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    const holds = path === point || path.startsWith(point.endsWith("/") ? point : `${point}/`);
    if (holds && point.length >= (covering?.point.length ?? 0)) covering = { point, options: options.split(",") };
  }
  return covering?.options.includes("noexec") ?? false;
}

function ownRoot(memory: string) {
  const uid = process.getuid!();
  const root = join(memory, `fleet-test-${uid}`);
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const found = lstatSync(root);
  return found.uid === uid && (found.mode & 0o077) === 0 ? root : undefined;
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
