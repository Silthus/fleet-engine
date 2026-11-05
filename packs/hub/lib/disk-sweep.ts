import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { freeBytes } from "../../base/lib/disk.ts";
import { trimLog } from "../../base/lib/prune.ts";
import { numberSetting } from "../../base/lib/settings.ts";
import type { Env, Result } from "./coder.ts";
import { spawnText } from "./hub-job.ts";

const gigabyte = 1024 ** 3;
const minute = 60_000;
const cleanerMinutes = 10;
const duMinutes = 5;
const largestCount = 10;
const megabyte = 1024 ** 2;
const usage = "Usage: fleet disk-sweep [--dry-run] [--floor <gigabytes>] [--alert-floor <gigabytes>]";

type Trim = { path: string; limitBytes: number; keepBytes: number };

export type Cleaner = { name: string; tool: string; argv: string[] } | { name: string; trim: Trim };

export type DiskSweepOptions = {
  home: string; dryRun: boolean; floorGigabytes: number; alertGigabytes: number;
  free: () => number;
  cleaners: Cleaner[];
  installed: (tool: string) => boolean;
  run: (argv: string[], timeoutMs: number) => Promise<Result>;
  trimLog: (path: string, limitBytes: number, keepBytes: number) => void;
  log: (line: string) => void;
  print: (line: string) => void;
};

export function sweepCleaners(home: string, env: Env): Cleaner[] {
  const launcher = join(env.FLEET_ENGINE_DIR ?? join(home, ".local/share/fleet/engine"), "fleet");
  return [
    { name: "fleet prune", tool: launcher, argv: ["sh", launcher, "prune"] },
    { name: "trim the T3 boot log", trim: { path: join(home, ".t3/userdata/logs/boot-service.log"), limitBytes: 100 * megabyte, keepBytes: 20 * megabyte } },
    { name: "pnpm store prune", tool: "pnpm", argv: ["pnpm", "store", "prune"] },
    { name: "uv cache prune", tool: "uv", argv: ["uv", "cache", "prune"] },
    { name: "go clean -cache", tool: "go", argv: ["go", "clean", "-cache"] },
  ];
}

const shownGigabytes = (bytes: number) => `${(bytes / gigabyte).toFixed(1)}G`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

export async function diskSweep(options: DiskSweepOptions): Promise<number> {
  const shownFree = () => `${shownGigabytes(options.free())} free`;
  options.log(`Sweep${options.dryRun ? " (dry run)" : ""}: ${shownFree()}, floor ${options.floorGigabytes}G.`);
  for (const cleaner of options.cleaners) {
    if ("tool" in cleaner && !options.installed(cleaner.tool)) { options.log(`Skipped ${cleaner.name}: ${cleaner.tool} is not installed.`); continue; }
    if (options.dryRun) { options.log(`Would run ${cleaner.name}.`); continue; }
    if (options.free() >= options.floorGigabytes * gigabyte) {
      options.log(`${shownFree()}, above the ${options.floorGigabytes}G floor, so the sweep stops.`);
      return 0;
    }
    options.log(`${await runCleaner(cleaner, options)} ${shownFree()}.`);
  }
  if (options.dryRun) return 0;
  if (options.free() >= options.floorGigabytes * gigabyte) {
    options.log(`${shownFree()}, above the ${options.floorGigabytes}G floor, so the sweep stops.`);
    return 0;
  }
  if (options.free() < options.alertGigabytes * gigabyte) {
    options.log(`Still ${shownFree()}, below the ${options.alertGigabytes}G alert floor. Nothing else is removed.`);
    options.print(await largestFolders(options));
  }
  return 0;
}

async function runCleaner(cleaner: Cleaner, options: DiskSweepOptions): Promise<string> {
  try {
    if ("trim" in cleaner) {
      options.trimLog(cleaner.trim.path, cleaner.trim.limitBytes, cleaner.trim.keepBytes);
      return `${cleaner.name}: done.`;
    }
    const ran = await options.run(cleaner.argv, cleanerMinutes * minute);
    if (ran.code === 0) return `${cleaner.name}: done.`;
    if (ran.code === 124) return `${cleaner.name} stopped at its ${cleanerMinutes} minute limit.`;
    return `${cleaner.name} failed with exit ${ran.code}: ${lastLine(ran.stderr) || lastLine(ran.stdout) || "it printed nothing"}.`;
  } catch (error) {
    return `${cleaner.name} failed: ${errorText(error)}.`;
  }
}

async function largestFolders(options: DiskSweepOptions): Promise<string> {
  const du = await options.run(["du", "-x", "-k", "-d", "2", options.home], duMinutes * minute).catch((error) => ({ code: 1, stdout: "", stderr: errorText(error) }));
  const folders = du.stdout.split("\n").flatMap((line) => {
    const [kilobytes, path] = line.split("\t");
    return path && path !== options.home && Number.isFinite(Number(kilobytes)) ? [{ path, bytes: Number(kilobytes) * 1024 }] : [];
  }).sort((a, b) => b.bytes - a.bytes).slice(0, largestCount);
  const note = du.code === 0 ? [] : [du.code === 124 ? `du did not finish in ${duMinutes} minutes, so the list may miss folders.` : "du could not read every folder, so the list may miss folders."];
  return ["The largest folders under $HOME, for you to decide:", ...folders.map((folder) => `${shownGigabytes(folder.bytes)} ${folder.path}`), ...note].join("\n");
}

type SweepArgs = { dryRun: boolean; floor?: number; alertFloor?: number };

function parseSweepArgs(args: string[]): SweepArgs {
  const parsed: SweepArgs = { dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dry-run") { parsed.dryRun = true; continue; }
    const value = Number(args[++index]);
    if ((arg !== "--floor" && arg !== "--alert-floor") || !(value > 0)) throw new Error(usage);
    parsed[arg === "--floor" ? "floor" : "alertFloor"] = value;
  }
  return parsed;
}

export type DiskSweepContext = {
  home: string; env: Env;
  log?: (line: string) => void; print?: (line: string) => void;
};

export async function diskSweepCommand(args: string[], context: DiskSweepContext): Promise<number> {
  const parsed = parseSweepArgs(args);
  const { home, env } = context;
  const floorGigabytes = parsed.floor ?? numberSetting("base.diskFloorGigabytes", env);
  const log = context.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  return diskSweep({
    home, dryRun: parsed.dryRun, floorGigabytes, alertGigabytes: parsed.alertFloor ?? floorGigabytes,
    free: () => freeBytes(home),
    cleaners: sweepCleaners(home, env),
    installed: (tool) => (isAbsolute(tool) ? existsSync(tool) : Boolean(Bun.which(tool, { PATH: env.PATH ?? "" }))),
    run: (argv, timeoutMs) => spawnText(argv, env, { timeoutMs, cwd: home }),
    trimLog: (path, limitBytes, keepBytes) => trimLog(path, limitBytes, keepBytes, log),
    log,
    print: context.print ?? ((line) => console.log(line)),
  });
}
