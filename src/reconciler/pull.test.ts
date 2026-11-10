import { afterEach, expect, test } from "bun:test";
import { tempDirs } from "../testing/git.ts";
import { linkedFleets } from "../testing/linked.ts";
import type { Clock } from "../runner/context.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

test("a node's apply pulls its credential from the hub over ssh, stores it, and ctx.use returns it", async () => {
  const { hub, node } = linkedFleets(temp);
  expect((await hub("apply")).code).toBe(0);
  expect(await node("issued", "use")).toEqual({ code: 1, output: "fleet: issued/issued-api has no credential on this machine yet. Run fleet apply on the hub." });
  const applied = await node("apply");
  expect(applied.code).toBe(0);
  expect(applied.output).not.toContain("Could not pull");
  expect(await node("issued", "use")).toEqual({ code: 0, output: "http://127.0.0.1:4600 key-2-for-node-2" });
  expect(await hub("issued", "use")).toEqual({ code: 0, output: "http://127.0.0.1:4600 key-1-for-hub-1" });
});

test("when the hub does not answer or refuses, the node keeps its stored credential and apply reports a finding", async () => {
  const { hub, node, hosts } = linkedFleets(temp);
  await hub("apply");
  await node("apply");
  const answering = hosts["hub-1"]!;

  hosts["hub-1"] = "down";
  const down = await node("apply");
  expect(down.code).toBe(0);
  expect(down.output).toContain("Fix: Could not pull the credential of issued/issued-api from the hub hub-1 (ssh: connect to host hub-1 port 22: Connection refused). Kept the one this machine has.");
  expect((await node("issued", "use")).output).toBe("http://127.0.0.1:4600 key-2-for-node-2");

  hosts["hub-1"] = answering;
  await hub("issued", "refuse");
  const refused = await node("apply");
  expect(refused.output).toContain("Fix: Could not pull the credential of issued/issued-api from the hub hub-1 (fleet: the service said no). Kept the one this machine has.");
  expect((await node("issued", "use")).output).toBe("http://127.0.0.1:4600 key-2-for-node-2");
});

/** A clock that moves only when the test advances it. next resolves when the next sleep after the call starts. */
function handClock() {
  let now = 0;
  const timers: Array<{ at: number; fire: () => void }> = [];
  let started: (() => void) | undefined;
  const clock: Clock = {
    now: () => now,
    sleep: (ms) => new Promise((fire) => (timers.push({ at: now + ms, fire }), started?.())),
  };
  return {
    clock,
    next: () => new Promise<void>((done) => (started = done)),
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((item) => item.at <= now)) timer.fire();
    },
  };
}

const settled = () => new Promise((done) => setImmediate(done));

test("a pull waits for a slow hub until its deadline, then gives up and the node keeps its stored credential", async () => {
  const hand = handClock();
  const { hub, hubFleet, node, hosts } = linkedFleets(temp, undefined, hand.clock);
  await hub("apply");
  expect((await node("apply")).output).not.toContain("Could not pull");

  const answer = Promise.withResolvers<void>();
  hosts["hub-1"] = async (args) => (await answer.promise, hubFleet(args));
  const slowStarted = hand.next();
  const slow = node("apply");
  await slowStarted;
  hand.advance(89_999);
  await settled();
  answer.resolve();
  expect((await slow).output).not.toContain("Could not pull");
  expect((await node("issued", "use")).output).toBe("http://127.0.0.1:4600 key-3-for-node-2");

  hosts["hub-1"] = () => new Promise(() => {});
  const stuckStarted = hand.next();
  const stuck = node("apply");
  await stuckStarted;
  hand.advance(90_000);
  const late = await stuck;
  expect(late.code).toBe(0);
  expect(late.output).toContain("Fix: Could not pull the credential of issued/issued-api from the hub hub-1 (it did not answer within 90 seconds). Kept the one this machine has.");
  expect((await node("issued", "use")).output).toBe("http://127.0.0.1:4600 key-3-for-node-2");
});

test("a pull's finding never names what the service printed or threw on the hub", async () => {
  const { hub, node } = linkedFleets(temp);
  await hub("apply");
  await node("apply");

  await hub("issued", "crash");
  const crashed = await node("apply");
  expect(crashed.output).toContain("(fleet: the service failed without an error message.)");
  expect(crashed.output).not.toContain("leaked-key");

  await hub("issued", "leak");
  const leaked = await node("apply");
  expect(leaked.output).toContain("Fix: Could not pull the credential of issued/issued-api from the hub hub-1 (fleet: the issue failed). Kept the one this machine has.");
  expect(leaked.output).not.toContain("leaked-key");
});

test("fleet credential frames each line the service prints with its pack, and gives one line for an error", async () => {
  const { hub, hubFleet } = linkedFleets(temp);
  await hub("apply");
  await hub("issued", "leak");
  expect(await hubFleet(["credential", "issued/issued-api", "node-2"])).toEqual({ code: 1, stdout: "", stderr: "issued: fleet: leaked-key\nissued: leaked-key\nfleet: the issue failed\n" });
});

test("a non-Error that the service throws on the hub fails with one fixed line", async () => {
  const { hub, hubFleet } = linkedFleets(temp);
  await hub("apply");
  await hub("issued", "crash");
  expect(await hubFleet(["credential", "issued/issued-api", "node-2"])).toEqual({ code: 1, stdout: "", stderr: "fleet: the service failed without an error message.\n" });
});

test("a pull's finding names ssh's or the hub shell's own line, and the last line of the hub's fleet, but no line of the service", async () => {
  const { hub, node, hosts } = linkedFleets(temp);
  await hub("apply");
  await node("apply");
  const reason = async (code: number, stderr: string) => {
    hosts["hub-1"] = async () => ({ code, stdout: "", stderr });
    return (await node("apply")).output.match(/hub-1 \((.*)\)\. Kept/)?.[1];
  };
  expect(await reason(137, "issued: key-9-for-node-2\n")).toBe("exit 137");
  expect(await reason(255, "issued: key-9-for-node-2\n")).toBe("exit 255");
  expect(await reason(255, "issued: key-9-for-node-2\nPermission denied (publickey).\n")).toBe("Permission denied (publickey).");
  expect(await reason(126, "sh: 1: fleet: Permission denied\n")).toBe("sh: 1: fleet: Permission denied");
  expect(await reason(127, "sh: 1: fleet: not found\n")).toBe("sh: 1: fleet: not found");
  expect(await reason(1, "fleet: the first\nissued: fleet: key-9-for-node-2\nfleet: the last\nissued: key-9-for-node-2\n")).toBe("fleet: the last");
});

test("fleet credential on the hub prints only the key for a node that the profile names, and what the service says goes to standard error", async () => {
  const { hub, hubFleet } = linkedFleets(temp);
  await hub("apply");
  expect(await hubFleet(["credential", "issued/issued-api", "node-2"])).toEqual({ code: 0, stdout: "key-2-for-node-2\n", stderr: "issued: Issuing a key for node-2\n" });
});

test("fleet credential refuses a node that the profile does not name", async () => {
  const { hub } = linkedFleets(temp);
  await hub("apply");
  expect(await hub("credential", "issued/issued-api", "stranger")).toEqual({ code: 1, output: "fleet: stranger is not a node of your profile. Name it in devboxes, or run fleet devbox add stranger." });
});

test("fleet credential refuses to run off the hub", async () => {
  const { node } = linkedFleets(temp);
  expect(await node("credential", "issued/issued-api", "node-2")).toEqual({ code: 1, output: "fleet: fleet credential runs on the hub, hub-1." });
});

test("fleet credential refuses a service that is not in the catalog", async () => {
  const { hub } = linkedFleets(temp);
  await hub("apply");
  expect(await hub("credential", "issued/issued-spare", "node-2")).toEqual({ code: 1, output: "fleet: the service catalog has no issued/issued-spare: its workflow or plan is off in your profile." });
});
