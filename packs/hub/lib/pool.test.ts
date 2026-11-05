import { afterEach, expect, test } from "bun:test";
import { mkdirSync, utimesSync } from "node:fs";
import { tempDirs } from "../../../src/testing/git.ts";
import { claim, drop, give, hold, own, poolFile, pooled, withPool } from "./pool.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

async function returned(file: string, box: string, size: number) {
  const held = await hold(file, box, `ws-${box}`, await own(file, box, `ws-${box}`));
  return give(file, box, held.state === "held" ? held.token : "", size);
}

test("the pool never hands one box to two spawns, and takes boxes back only while it has room", async () => {
  const file = poolFile(temp.make("fleet-pool-"));
  for (const box of ["box-a", "box-b", "box-c"]) expect(await returned(file, box, 8)).toBe(true);
  const claims = await Promise.all(Array.from({ length: 20 }, () => claim(file)));
  expect(claims.flatMap((claimed) => (claimed ? [claimed.box] : [])).sort()).toEqual(["box-a", "box-b", "box-c"]);
  expect(pooled(file)).toEqual([]);
  for (let index = 0; index < 3; index += 1) expect(await returned(file, `box-${index}`, 3)).toBe(true);
  expect(await returned(file, "box-extra", 3)).toBe(false);
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

test("overlapping releases cannot hand one box to two claimants: a return counts only for the box's current claim", async () => {
  const file = poolFile(temp.make("fleet-pool-"));
  const spawned = await own(file, "box-a", "ws-a");
  const releaseA = await hold(file, "box-a", "ws-a", spawned);
  expect(releaseA.state).toBe("held");
  expect((await hold(file, "box-a", "ws-a", spawned)).state).toBe("stale");
  expect(await give(file, "box-a", releaseA.state === "held" ? releaseA.token : "", 4)).toBe(true);
  const spawnA = await claim(file);
  expect(spawnA).toEqual({ box: "box-a", id: "ws-a", claim: expect.any(String) });
  expect(spawnA?.claim).not.toBe(spawned);
  const releaseB = await hold(file, "box-a", "ws-a", spawned);
  expect(releaseB.state).toBe("stale");
  expect(await give(file, "box-a", "a-token-from-nowhere", 4).catch(() => "refused")).toBe("refused");
  expect(await claim(file)).toBeUndefined();
  expect(pooled(file)).toEqual([]);
});

test("only boxes the pool recorded can be held, and a pool file from older code hands out none of its unrecorded boxes", async () => {
  const file = poolFile(temp.make("fleet-pool-"));
  await withPool(file, (pool) => void pool.free.push("box-personal"));
  await own(file, "box-mine", "ws-mine");
  expect((await hold(file, "box-personal", "ws-personal")).state).toBe("unowned");
  expect((await hold(file, "box-mine", "ws-other")).state).toBe("unowned");
  expect(await claim(file)).toBeUndefined();
});
