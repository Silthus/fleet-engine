import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync } from "node:fs";
import { tempDirs } from "../../../src/testing/git.ts";
import { holdMs, poolAt, poolFile, pooled, withPool, type Pool, type PoolClient } from "./pool.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function fakeClock() {
  let now = Date.parse("2026-11-01T00:00:00Z");
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

function poolIn(size = 4) {
  const file = poolFile(temp.make("fleet-pool-"));
  const clock = fakeClock();
  return { file, clock, pool: poolAt(file, size, clock) };
}

const tokenOf = (held: Awaited<ReturnType<PoolClient["hold"]>>) => (held.state === "held" ? held.token : "");
const entries = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as Pool).boxes;

async function returned(pool: PoolClient, box: string) {
  const held = await pool.hold(box, `ws-${box}`, await pool.own(box, `ws-${box}`));
  return pool.give(box, tokenOf(held));
}

test("the pool never hands one box to two spawns, and takes boxes back only while it has room", async () => {
  const { file, pool } = poolIn(8);
  for (const box of ["box-a", "box-b", "box-c"]) expect(await returned(pool, box)).toBe(true);
  const claims = await Promise.all(Array.from({ length: 20 }, () => pool.claim()));
  expect(claims.flatMap((claimed) => (claimed ? [claimed.box] : [])).sort()).toEqual(["box-a", "box-b", "box-c"]);
  expect(pooled(file)).toEqual([]);
  const small = poolAt(file, 3, fakeClock());
  for (let index = 0; index < 3; index += 1) expect(await returned(small, `box-${index}`)).toBe(true);
  expect(await returned(small, "box-extra")).toBe(false);
  expect(entries(file)["box-extra"]?.hold).toBeDefined();
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
  const { file, pool } = poolIn();
  const spawned = await pool.own("box-a", "ws-a");
  const releaseA = await pool.hold("box-a", "ws-a", spawned);
  expect(releaseA.state).toBe("held");
  expect((await pool.hold("box-a", "ws-a", spawned)).state).toBe("busy");
  expect(await pool.give("box-a", tokenOf(releaseA))).toBe(true);
  const spawnA = await pool.claim();
  expect(spawnA).toEqual({ box: "box-a", id: "ws-a", claim: expect.any(String) });
  expect(spawnA?.claim).not.toBe(spawned);
  expect((await pool.hold("box-a", "ws-a", spawned)).state).toBe("stale");
  expect(await pool.give("box-a", "a-token-from-nowhere").catch(() => "refused")).toBe("refused");
  expect(await pool.claim()).toBeUndefined();
  expect(pooled(file)).toEqual([]);
});

test("only boxes the pool recorded can be held, and a pool file from older code hands out none of its unrecorded boxes", async () => {
  const { file, pool } = poolIn();
  await withPool(file, (state) => void state.free.push("box-personal"));
  await pool.own("box-mine", "ws-mine");
  expect((await pool.hold("box-personal", "ws-personal")).state).toBe("unowned");
  expect((await pool.hold("box-mine", "ws-other")).state).toBe("unowned");
  expect(await pool.claim()).toBeUndefined();
});

test("a hold from a release that crashed keeps others out until it expires; the takeover gets a new token and fences the crashed release out", async () => {
  const { file, clock, pool } = poolIn();
  const lane = await pool.own("box-a", "ws-a");
  const crashed = tokenOf(await pool.hold("box-a", "ws-a", lane));
  expect((await pool.hold("box-a", "ws-a")).state).toBe("busy");
  await clock.sleep(holdMs - 1);
  expect((await pool.hold("box-a", "ws-a")).state).toBe("busy");
  await clock.sleep(1);
  const takeover = tokenOf(await pool.hold("box-a", "ws-a", lane));
  expect(takeover).not.toBe("");
  expect(takeover).not.toBe(crashed);
  expect(await pool.renew("box-a", crashed)).toBe(false);
  expect(await pool.give("box-a", crashed).catch(() => "refused")).toBe("refused");
  await pool.unhold("box-a", crashed);
  await pool.drop("box-a", crashed);
  expect(entries(file)["box-a"]).toEqual({ id: "ws-a", claim: lane, hold: { token: takeover, until: clock.now() + holdMs } });
  await clock.sleep(holdMs - 1);
  expect(await pool.renew("box-a", takeover)).toBe(true);
  await clock.sleep(holdMs - 1);
  expect((await pool.hold("box-a", "ws-a")).state).toBe("busy");
  expect(await pool.give("box-a", takeover)).toBe(true);
  expect(pooled(file)).toEqual(["box-a"]);
});

test("a start takes a free box out of the pool with a new claim, and a lane-held box with the claim it has", async () => {
  const { file, pool } = poolIn();
  await returned(pool, "box-free");
  const lane = await pool.own("box-lane", "ws-box-lane");
  const fromPool = await pool.hold("box-free", "ws-box-free");
  expect(fromPool).toEqual({ state: "held", token: expect.any(String), claim: expect.any(String) });
  expect(pooled(file)).toEqual([]);
  const laneHeld = await pool.hold("box-lane", "ws-box-lane");
  expect(laneHeld).toEqual({ state: "held", token: expect.any(String) });
  await pool.unhold("box-lane", tokenOf(laneHeld));
  expect(entries(file)["box-lane"]).toEqual({ id: "ws-box-lane", claim: lane });
});

test("a box is dropped only by its current hold or claim, so a late drop cannot forget a newer box with the same name", async () => {
  const { file, pool } = poolIn();
  const old = await pool.own("box-a", "ws-old");
  const newer = await pool.own("box-a", "ws-new");
  await pool.drop("box-a", old);
  expect(entries(file)["box-a"]).toEqual({ id: "ws-new", claim: newer });
  await pool.drop("box-a", newer);
  expect(entries(file)["box-a"]).toBeUndefined();
});
