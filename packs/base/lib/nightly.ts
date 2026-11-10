import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { engineCommand } from "../../../src/reconciler/engine-command.ts";

export const nightWindowUtc = { firstHour: 0, lastHour: 5 };

const usage = "usage: fleet nightly <id> -- <command>...";
const stampFile = (home: string, id: string) => join(home, ".local/state/fleet/nightly", id);

export type NightlyContext = { home: string; engineRoot: string | undefined; now: () => Date; run: (command: string[]) => Promise<number> };

export async function nightlyCommand(args: string[], context: NightlyContext): Promise<number> {
  const [id, separator, ...command] = args;
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || separator !== "--" || !command.length) throw new Error(usage);
  const now = context.now();
  if (now.getUTCHours() < nightWindowUtc.firstHour || now.getUTCHours() > nightWindowUtc.lastHour) return 0;
  const today = now.toISOString().slice(0, 10);
  const stamp = stampFile(context.home, id);
  if ((await readFile(stamp, "utf8").catch(() => "")).trim() === today) return 0;
  const code = await context.run(engineCommand(command, context.engineRoot));
  if (code !== 0) return code;
  await mkdir(dirname(stamp), { recursive: true });
  await writeFile(stamp, `${today}\n`);
  return 0;
}
