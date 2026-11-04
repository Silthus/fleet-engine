import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { diskStatus } from "./disk.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const gigabyte = 1024 ** 3;

test("calls the disk critical below the floor", () => {
  expect(diskStatus(25 * gigabyte, 20)).toEqual({ critical: false, message: "Disk: 25.0G free." });
  expect(diskStatus(15 * gigabyte, 20)).toEqual({
    critical: true,
    message: "Disk is critical: 15.0G free, below 20G. Do not start worktree lanes or heavy jobs here. fleet prune frees space every few minutes.",
  });
});

async function disk(settings: Record<string, unknown> | undefined, ...args: string[]) {
  const env = { ...Bun.env, HOME: temp.make("home-"), FLEET_SETTINGS: settings && JSON.stringify(settings) };
  const child = Bun.spawn(["bun", join(import.meta.dir, "../commands/disk.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

test("fleet disk exits 1 while free space is under the floor setting", async () => {
  expect(await disk({ "base.diskFloorGigabytes": 0 })).toMatchObject({ code: 0, stdout: expect.stringMatching(/^Disk: /) });
  expect(await disk({ "base.diskFloorGigabytes": 1e9 })).toMatchObject({ code: 1, stderr: expect.stringMatching(/^Disk is critical: /) });
  expect(await disk({ "base.diskFloorGigabytes": 0 }, "extra")).toMatchObject({ code: 2, stderr: "Usage: fleet disk\n" });
  expect((await disk(undefined)).stderr).toContain("run this command as fleet <command>");
});
