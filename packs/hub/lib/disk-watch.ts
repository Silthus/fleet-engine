import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freeBytes } from "../../base/lib/disk.ts";
import { numberSetting, stringSetting } from "../../base/lib/settings.ts";
import type { Env } from "./coder.ts";
import { threadModel, requireHubRole, spawnText, sshArgv, stateDir, threadScript, underLock, writeStateFile, type JobContext } from "./hub-job.ts";
import { devboxesOf, remoteFleet } from "./machine.ts";

const gigabyte = 1024 ** 3;
const hour = 3600_000;
const sweepEveryHours = 1;
const repeatHours = 24;
const reportLines = 40;
const alertModel = "claude-haiku-5-5";
const sweepMinutes = 90;

export type DiskWatchOptions = {
  boxes: string[]; statePath: string; now: () => number; log: (line: string) => void; dryRun?: boolean;
  sweepBelowGigabytes: number; alertBelowGigabytes: number;
  read: (box: string) => Promise<number | null>;
  sweep: (box: string) => Promise<string>;
  alert: (box: string, free: number, report: string) => Promise<boolean>;
};

type WatchState = Record<string, { sweptAt?: number; alertedAt?: number }>;

export async function watchDisks(options: DiskWatchOptions): Promise<void> {
  const state = readState(options.statePath);
  await Promise.all(options.boxes.map((box) => watchDisk(box, state, options)));
  if (!options.dryRun) writeStateFile(options.statePath, state);
}

async function watchDisk(box: string, state: WatchState, options: DiskWatchOptions): Promise<void> {
  let free = await options.read(box);
  if (free === null) { options.log(`${box}: unreachable`); return; }
  if (free >= options.sweepBelowGigabytes * gigabyte) { delete state[box]; options.log(shown(box, free)); return; }
  const entry = state[box] ??= {};
  let report = "No sweep ran in this pass. The last one ran less than an hour ago.";
  if (options.now() - (entry.sweptAt ?? 0) < sweepEveryHours * hour) options.log(`${shown(box, free)}; swept already`);
  else if (options.dryRun) options.log(`${shown(box, free)}; would sweep`);
  else {
    options.log(`${shown(box, free)}; sweeping`);
    report = (await options.sweep(box)).split("\n").slice(-reportLines).join("\n");
    entry.sweptAt = options.now();
    free = await options.read(box) ?? free;
    options.log(`${shown(box, free)} after the sweep`);
  }
  if (free >= options.alertBelowGigabytes * gigabyte) return;
  if (options.now() - (entry.alertedAt ?? 0) < repeatHours * hour) { options.log(`${box}: alerted already`); return; }
  if (options.dryRun) { options.log(`${box}: would alert`); return; }
  const alerted = await options.alert(box, free, report);
  if (alerted) entry.alertedAt = options.now();
  options.log(`${box}: ${alerted ? "alerted" : "alert failed"}`);
}

const shown = (box: string, free: number) => `${box}: ${(free / gigabyte).toFixed(1)}G free`;

function readState(path: string): WatchState {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(state).filter(([, entry]) => typeof entry === "object" && entry !== null)) as WatchState;
  } catch { return {}; }
}

export function diskWatchTargets(env: Env, home: string, hub: string, self: string): { local: string; remote: string[] } {
  return { local: hub, remote: devboxesOf(env, home).filter((box) => box !== hub && box !== self) };
}

export type DiskWatchContext = JobContext & { localFree?: () => number };

function hubDisks(context: DiskWatchContext, local: string, sweepBelowGigabytes: number, alertBelowGigabytes: number) {
  const { env } = context;
  const onBox = (box: string, command: string) => (box === local ? ["sh", "-c", command] : sshArgv(box, command));
  const localFleet = join(env.FLEET_ENGINE_DIR ?? join(context.home, ".local/share/fleet/engine"), "fleet");
  const read = async (box: string) => {
    if (box === local) return (context.localFree ?? (() => freeBytes(context.home)))();
    const df = await spawnText(sshArgv(box, 'df -Pk "$HOME"'), env, { timeoutMs: 30_000 });
    const available = Number(df.stdout.trim().split("\n")[1]?.split(/\s+/)[3]);
    return df.code === 0 && Number.isFinite(available) ? available * 1024 : null;
  };
  const sweep = async (box: string) => {
    const floors = ["--floor", String(sweepBelowGigabytes), "--alert-floor", String(alertBelowGigabytes)];
    const argv = box === local ? ["sh", localFleet, "disk-sweep", ...floors] : sshArgv(box, `${remoteFleet(["disk-sweep", ...floors].join(" "))} 2>&1`);
    const swept = await spawnText(argv, env, { timeoutMs: sweepMinutes * 60_000 });
    const output = `${swept.stdout}${swept.stderr}`.trim();
    return swept.code === 0 ? output : `The sweep failed with exit ${swept.code === 124 ? "timeout" : swept.code}.\n${output}`;
  };
  const alert = async (box: string, free: number, report: string) => {
    const shownFree = `${(free / gigabyte).toFixed(1)}G`;
    const look = `df -h ~; ${remoteFleet("prune --dry-run --no-fetch --min-idle-hours 1")}`;
    const prompt = `${box} has ${shownFree} free, below ${alertBelowGigabytes}G, though a cleanup sweep ran within the hour. A full disk crashes T3 and every lane on the box.
The sweep ran T3's storage cleanup, fleet prune, and the package managers' own cache cleaners, and removed nothing else. Its report from this pass ends with the largest folders under $HOME:

${report}

Check what is left, read-only: run \`${box === local ? look : `ssh ${box} '${look}'`}\`.
Delete nothing and start no lanes. Reply in at most 10 lines: the free space, the largest folders the report names, and what your user must decide to free it.`;
    const script = threadScript(stringSetting("hub.threadFolder", env), `${box}: ${shownFree} free`, threadModel("lookup", alertModel, env));
    return (await spawnText(onBox(local, script), env, { stdin: prompt, timeoutMs: 600_000 })).code === 0;
  };
  return { read, sweep, alert, sweepBelowGigabytes };
}

export async function diskWatchCommand(args: string[], context: DiskWatchContext): Promise<number> {
  const dryRun = args[0] === "--dry-run";
  if (args.length > Number(dryRun)) throw new Error("Usage: fleet disk-watch [--dry-run]");
  requireHubRole(context.home, "disk-watch");
  const { env } = context;
  const targets = diskWatchTargets(env, context.home, stringSetting("hub.alias", env), context.self);
  const sweepBelowGigabytes = numberSetting("hub.diskSweepGigabytes", env);
  const alertBelowGigabytes = numberSetting("hub.diskAlertGigabytes", env);
  return underLock(context, "disk-watch", "The disk watch", async () => {
    await watchDisks({
      boxes: [targets.local, ...targets.remote], statePath: join(stateDir(context.home, env), "disk-watch.json"), now: context.now, log: context.log, dryRun,
      alertBelowGigabytes, ...hubDisks(context, targets.local, sweepBelowGigabytes, alertBelowGigabytes),
    });
    return 0;
  });
}
