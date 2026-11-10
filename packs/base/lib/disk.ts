import { existsSync, readFileSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { numberSetting, optionalStringSetting } from "./settings.ts";

type Env = Record<string, string | undefined>;

const gigabyte = 1024 ** 3;
const hour = 3600_000;
const usage = "Usage: fleet disk [--start [--min-free <GB>]]";

export const startFloorVariable = "FLEET_START_MIN_FREE_GB";
export const freeMapFile = "disk-free.json";

export type DiskStatus = { critical: boolean; message: string };
export type FreeMap = { checkedAt: string; boxes: Record<string, number> };
export type StartPlace = { here: string; freeMap: () => FreeMap | undefined; now: number };

export const diskFloorGigabytes = () => numberSetting("base.diskFloorGigabytes");

export function freeBytes(path: string): number {
  const stats = statfsSync(nearestExisting(path));
  return stats.bavail * stats.bsize;
}

function nearestExisting(path: string): string {
  return existsSync(path) || dirname(path) === path ? path : nearestExisting(dirname(path));
}

const shown = (free: number) => `${(free / gigabyte).toFixed(1)}G free`;

export function diskStatus(free: number, floorGigabytes: number): DiskStatus {
  if (free >= floorGigabytes * gigabyte) return { critical: false, message: `Disk: ${shown(free)}.` };
  return {
    critical: true,
    message: `Disk is critical: ${shown(free)}, below ${floorGigabytes}G. Do not start worktree lanes or heavy jobs here. fleet prune frees space every few minutes.`,
  };
}

class UsageError extends Error {}

function gigabytes(value: string, name: string): number {
  const floor = Number(value);
  if (value.trim() === "" || !Number.isFinite(floor) || floor < 0) throw new UsageError(`${name} must be a number of gigabytes, not '${value}'.`);
  return floor;
}

function startFloor(args: string[], env: Env): number {
  if (args.length === 2 && args[0] === "--min-free") return gigabytes(args[1]!, "--min-free");
  if (args.length) throw new UsageError(usage);
  const variable = env[startFloorVariable];
  return variable === undefined || variable === "" ? numberSetting("base.startFloorGigabytes", env) : gigabytes(variable, startFloorVariable);
}

export function startDecision(free: number, floor: number, place: StartPlace): DiskStatus {
  if (free >= floor * gigabyte) return { critical: false, message: `Disk: ${shown(free)}, above the ${floor}G floor for new threads.` };
  const map = place.freeMap();
  const fresh = map && place.now - Date.parse(map.checkedAt) < hour ? map : undefined;
  const [best] = Object.entries(fresh?.boxes ?? {})
    .filter(([box, bytes]) => box !== place.here && bytes >= floor * gigabyte)
    .sort((a, b) => b[1] - a[1]);
  const elsewhere = best
    ? `${best[0]} has ${shown(best[1])} (disk-watch, ${Math.round((place.now - Date.parse(fresh!.checkedAt)) / 60_000)} min ago): start it there.`
    : "Fleet knows no devbox with room. The hub's disk watch measures them every 15 minutes.";
  return {
    critical: true,
    message: [
      `Fleet starts no new thread or scheduled run on ${place.here}: ${shown(free)}, below the ${floor}G floor. A full disk stops every run on the machine.`,
      "Run fleet disk to check the space, and fleet prune --dry-run to see what it can free.",
      elsewhere,
      `${startFloorVariable} or --min-free <GB> changes the floor.`,
    ].join("\n"),
  };
}

export function diskCommand(args: string[], free: number, floorGigabytes: number, place?: StartPlace, env: Env = Bun.env): number {
  if (args[0] === "--start" && place) return startCommand(args.slice(1), free, place, env);
  if (args.length) {
    console.error(usage);
    return 2;
  }
  const status = diskStatus(free, floorGigabytes);
  if (status.critical) {
    console.error(status.message);
    return 1;
  }
  console.log(status.message);
  return 0;
}

function startCommand(args: string[], free: number, place: StartPlace, env: Env): number {
  let floor: number;
  try {
    floor = startFloor(args, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return 2;
  }
  const decision = startDecision(free, floor, place);
  if (decision.critical) {
    console.error(decision.message);
    return 75;
  }
  console.log(decision.message);
  return 0;
}

export const freeMapPath = (home: string, env: Env = Bun.env) => join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "fleet", freeMapFile);

function parseFreeMap(text: string): FreeMap | undefined {
  try {
    const map = JSON.parse(text) as FreeMap;
    return typeof map.checkedAt === "string" && typeof map.boxes === "object" && map.boxes !== null ? map : undefined;
  } catch {
    return undefined;
  }
}

export function readFreeMap(home: string, env: Env = Bun.env): FreeMap | undefined {
  try {
    return parseFreeMap(readFileSync(freeMapPath(home, env), "utf8"));
  } catch {}
  const hub = optionalStringSetting("hub.alias", env);
  if (!hub) return undefined;
  const answer = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", hub, `cat "\${XDG_STATE_HOME:-$HOME/.local/state}/fleet/${freeMapFile}"`], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  return answer.exitCode === 0 ? parseFreeMap(answer.stdout.toString()) : undefined;
}
