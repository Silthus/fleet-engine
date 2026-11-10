import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { engineCommand } from "../../../src/reconciler/engine-command.ts";

export const nightWindowUtc = { firstHour: 0, lastHour: 5 };

const usage = "usage: fleet nightly <id> -- <command>...";
const stampFile = (home: string, id: string) => join(home, ".local/state/fleet/nightly", id);

export type NightlyContext = { home: string; engineRoot: string | undefined; now: () => Date };

export async function nightlyCommand(args: string[], context: NightlyContext): Promise<number> {
  const [id, separator, ...command] = args;
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || separator !== "--" || !command.length) throw new Error(usage);
  const now = context.now();
  if (now.getUTCHours() < nightWindowUtc.firstHour || now.getUTCHours() > nightWindowUtc.lastHour) return 0;
  const today = now.toISOString().slice(0, 10);
  const stamp = stampFile(context.home, id);
  const lock = `${stamp}.lock`;
  if (!(await claim(lock))) return 0;
  try {
    if ((await readFile(stamp, "utf8").catch(() => "")).trim() === today) return 0;
    const code = await Bun.spawn(engineCommand(command, context.engineRoot), { stdio: ["ignore", "inherit", "inherit"] }).exited;
    if (code === 0) await writeFile(stamp, `${today}\n`);
    return code;
  } finally {
    await rm(lock, { force: true });
  }
}

async function claim(lock: string) {
  await mkdir(dirname(lock), { recursive: true });
  if (await create(lock)) return true;
  if (running(Number((await readFile(lock, "utf8").catch(() => "")).trim()))) return false;
  await rm(lock, { force: true });
  return await create(lock);
}

async function create(lock: string) {
  const draft = `${lock}.${process.pid}`;
  await writeFile(draft, `${process.pid}\n`);
  try {
    await link(draft, lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(draft, { force: true });
  }
}

function running(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
