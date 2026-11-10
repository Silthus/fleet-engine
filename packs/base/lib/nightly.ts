import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { engineCommand } from "../../../src/reconciler/engine-command.ts";

export const nightWindowUtc = { firstHour: 0, lastHour: 5 };

const usage = "usage: fleet nightly <id> -- <command>...";
const stampFile = (home: string, id: string) => join(home, ".local/state/fleet/nightly", id);
const stillRunning = 75;

export type NightlyContext = { home: string; engineRoot: string | undefined; now: () => Date };

export async function nightlyCommand(args: string[], context: NightlyContext): Promise<number> {
  const [id, separator, ...command] = args;
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || separator !== "--" || !command.length) throw new Error(usage);
  const now = context.now();
  if (now.getUTCHours() < nightWindowUtc.firstHour || now.getUTCHours() > nightWindowUtc.lastHour) return 0;
  const today = now.toISOString().slice(0, 10);
  const stamp = stampFile(context.home, id);
  if ((await readFile(stamp, "utf8").catch(() => "")).trim() === today) return 0;
  await mkdir(dirname(stamp), { recursive: true });
  const code = await Bun.spawn(oneAtATime(`${stamp}.lock`, engineCommand(command, context.engineRoot)), { stdio: ["ignore", "inherit", "inherit"] }).exited;
  if (code === stillRunning) return 0;
  if (code === 0) await writeFile(stamp, `${today}\n`);
  return code;
}

function oneAtATime(lock: string, command: string[]) {
  const flock = Bun.which("flock");
  return flock ? [flock, "-n", "-E", String(stillRunning), lock, ...command] : command;
}
