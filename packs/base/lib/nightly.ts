import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { engineCommand } from "../../../src/reconciler/engine-command.ts";

export const nightWindowUtc = { firstHour: 0, lastHour: 5 };

const usage = "usage: fleet nightly <id> -- <command>...";
const stampFile = (home: string, id: string) => join(home, ".local/state/fleet/nightly", id);
const stillRunning = 75;

const onceADay = `stamp=$1 today=$2
shift 2
[ "$(cat "$stamp" 2>/dev/null)" = "$today" ] && exit 0
"$@"
code=$?
[ "$code" = ${stillRunning} ] && exit 1
[ "$code" = 0 ] || exit "$code"
echo "$today" > "$stamp"`;

export type NightlyContext = { home: string; engineRoot: string | undefined; now: () => Date };

export async function nightlyCommand(args: string[], context: NightlyContext): Promise<number> {
  const [id, separator, ...command] = args;
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || separator !== "--" || !command.length) throw new Error(usage);
  const now = context.now();
  if (now.getUTCHours() < nightWindowUtc.firstHour || now.getUTCHours() > nightWindowUtc.lastHour) return 0;
  const stamp = stampFile(context.home, id);
  await mkdir(dirname(stamp), { recursive: true });
  const once = ["/bin/sh", "-c", onceADay, "fleet-nightly", stamp, now.toISOString().slice(0, 10), ...engineCommand(command, context.engineRoot)];
  const code = await Bun.spawn(oneAtATime(`${stamp}.lock`, once), { stdio: ["ignore", "inherit", "inherit"] }).exited;
  return code === stillRunning ? 0 : code;
}

function oneAtATime(lock: string, command: string[]) {
  const flock = Bun.which("flock");
  return flock ? [flock, "-n", "-E", String(stillRunning), lock, ...command] : command;
}
