import { existsSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { numberSetting } from "./settings.ts";

const gigabyte = 1024 ** 3;

export type DiskStatus = { critical: boolean; message: string };

export const diskFloorGigabytes = () => numberSetting("base.diskFloorGigabytes");

export function freeBytes(path: string): number {
  const stats = statfsSync(nearestExisting(path));
  return stats.bavail * stats.bsize;
}

function nearestExisting(path: string): string {
  return existsSync(path) || dirname(path) === path ? path : nearestExisting(dirname(path));
}

export function diskStatus(free: number, floorGigabytes: number): DiskStatus {
  const shown = `${(free / gigabyte).toFixed(1)}G free`;
  if (free >= floorGigabytes * gigabyte) return { critical: false, message: `Disk: ${shown}.` };
  return {
    critical: true,
    message: `Disk is critical: ${shown}, below ${floorGigabytes}G. Do not start worktree lanes or heavy jobs here. fleet prune frees space every few minutes.`,
  };
}

export function diskCommand(args: string[], free: number, floorGigabytes: number): number {
  if (args.length) {
    console.error("Usage: fleet disk");
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
