import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import * as registry from "./pool.ts";
import { forget, giveBack, leave, poolFile, pooled, record, recorded, settle, stay, take, withPool, type Pool } from "./pool.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const fileIn = () => poolFile(temp.make("fleet-pool-"));
const change = <T>(file: string, step: (pool: Pool) => T) => withPool(file, step);

test("the pool never hands one box to two spawns, and takes boxes back only while it has room", async () => {
  const file = fileIn();
  for (const box of ["box-a", "box-b", "box-c"]) {
    await change(file, (pool) => record(pool, box, `ws-${box}`));
    expect(await change(file, (pool) => giveBack(pool, box, `ws-${box}`, 3))).toBe(true);
  }
  await change(file, (pool) => record(pool, "box-extra", "ws-box-extra"));
  expect(await change(file, (pool) => giveBack(pool, "box-extra", "ws-box-extra", 3))).toBe(false);
  expect(recorded(file)["box-extra"]?.claim).toBeString();
  const taken = await Promise.all(Array.from({ length: 20 }, (_, index) => change(file, (pool) => take(pool, ["box-a", "box-b", "box-c"][index % 3]!))));
  expect(taken.filter(Boolean)).toHaveLength(3);
  expect(pooled(file)).toEqual([]);
});

test("a lock left by a crashed run is taken over once stale, and a held lock fails after a minute on the injected clock", async () => {
  const file = fileIn();
  mkdirSync(`${file}.lock`, { recursive: true });
  let now = Date.now();
  const clock = { now: () => now, sleep: async (ms: number) => void (now += ms) };
  await expect(withPool(file, () => 1, clock)).rejects.toThrow("stayed locked for a minute");
  const old = new Date(Date.now() - 3 * 60_000);
  utimesSync(`${file}.lock`, old, old);
  expect(await withPool(file, () => 2, { now: Date.now, sleep: clock.sleep })).toBe(2);
});

test("taking a free box gives it a new claim and marks it as being handed over until the operation settles it", async () => {
  const file = fileIn();
  await change(file, (pool) => record(pool, "box-a", "ws-a"));
  await change(file, (pool) => giveBack(pool, "box-a", "ws-a", 4));
  expect(recorded(file)["box-a"]).toEqual({ id: "ws-a" });
  const taken = await change(file, (pool) => take(pool, "box-a"));
  expect(taken).toEqual({ id: "ws-a", claim: expect.any(String) });
  expect(recorded(file)["box-a"]).toEqual({ id: "ws-a", claim: taken!.claim, claiming: true });
  expect(await change(file, (pool) => take(pool, "box-a"))).toBeUndefined();
  await change(file, (pool) => settle(pool, "box-a", "ws-a"));
  expect(recorded(file)["box-a"]).toEqual({ id: "ws-a", claim: taken!.claim });
});

test("every change names the workspace id, so a late change cannot touch a newer box with the same name", async () => {
  const file = fileIn();
  await change(file, (pool) => record(pool, "box-a", "ws-old"));
  const newer = await change(file, (pool) => record(pool, "box-a", "ws-new"));
  await change(file, (pool) => leave(pool, "box-a", "ws-old", "delete"));
  await change(file, (pool) => settle(pool, "box-a", "ws-old"));
  expect(await change(file, (pool) => giveBack(pool, "box-a", "ws-old", 4))).toBe(false);
  await change(file, (pool) => forget(pool, "box-a", "ws-old"));
  expect(recorded(file)["box-a"]).toEqual({ id: "ws-new", claim: newer, claiming: true });
  await change(file, (pool) => leave(pool, "box-a", "ws-new", "pool"));
  expect(recorded(file)["box-a"]?.leaving).toBe("pool");
  await change(file, (pool) => stay(pool, "box-a", "ws-new"));
  expect(recorded(file)["box-a"]?.leaving).toBeUndefined();
  await change(file, (pool) => forget(pool, "box-a", "ws-new"));
  expect(recorded(file)["box-a"]).toBeUndefined();
});

test("a pool file from the old code keeps its boxes: refreshing ones are free again, and holds are dropped", async () => {
  const file = fileIn();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ free: ["box-a", "box-gone"], refreshing: ["box-b"], boxes: { "box-a": { id: "ws-a" }, "box-b": { id: "ws-b", hold: { token: "t", until: 1 } }, "box-c": { id: "ws-c", claim: "c-1", hold: { token: "t", until: 1 } } } }));
  expect(pooled(file)).toEqual(["box-a", "box-b"]);
  await change(file, () => undefined);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ free: ["box-a", "box-b"], boxes: { "box-a": { id: "ws-a" }, "box-b": { id: "ws-b" }, "box-c": { id: "ws-c", claim: "c-1" } } });
});

test("the pool has no hold, renew or token any more: nothing can be accepted on an expired lease, because no lease exists", () => {
  expect(Object.keys(registry).filter((name) => /hold|renew|token|own|drop|give$/i.test(name))).toEqual([]);
});
