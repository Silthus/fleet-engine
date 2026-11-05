import { afterEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync } from "node:fs";
import { tempDirs } from "../../../src/testing/git.ts";
import { claim, drop, give, poolFile, pooled, withPool } from "./pool.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

test("the pool never hands one box to two spawns, and takes boxes back only while it has room", async () => {
  const file = poolFile(temp.make("fleet-pool-"));
  for (const box of ["box-a", "box-b", "box-c"]) expect(await give(file, box, 8)).toBe(true);
  expect(await give(file, "box-a", 8)).toBe(true);
  const claims = await Promise.all(Array.from({ length: 20 }, () => claim(file)));
  expect(claims.filter(Boolean).sort()).toEqual(["box-a", "box-b", "box-c"]);
  expect(pooled(file)).toEqual([]);
  for (let index = 0; index < 3; index += 1) expect(await give(file, `box-${index}`, 3)).toBe(true);
  expect(await give(file, "box-extra", 3)).toBe(false);
  await drop(file, "box-1");
  expect(pooled(file)).toEqual(["box-0", "box-2"]);
});

test("a lock left by a crashed run is taken over once stale, and a held lock fails after a minute on the injected clock", async () => {
  const file = poolFile(temp.make("fleet-pool-"));
  mkdirSync(`${file}.lock`, { recursive: true });
  let now = Date.now();
  const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
  await expect(withPool(file, () => 1, clock)).rejects.toThrow("stayed locked for a minute");
  const old = new Date(Date.now() - 3 * 60_000);
  utimesSync(`${file}.lock`, old, old);
  expect(await withPool(file, () => 2, { now: Date.now, sleep: clock.sleep })).toBe(2);
});
