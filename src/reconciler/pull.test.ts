import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { linkedFleets } from "../testing/linked.ts";
import type { Clock } from "../runner/context.ts";
import { leakedKey } from "./fixtures/issued/pack.ts";

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
  expect(down.output).toContain("Fix: Could not pull the credential of issued/issued-api from the hub hub-1 (ssh exited 255. Run ssh hub-1 true to see why). Kept the one this machine has.");
  expect((await node("issued", "use")).output).toBe("http://127.0.0.1:4600 key-2-for-node-2");

  hosts["hub-1"] = answering;
  await hub("issued", "refuse");
  const refused = await node("apply");
  expect(refused.output).toContain("Fix: Could not pull the credential of issued/issued-api from the hub hub-1 (fleet credential exited 1 there. Run fleet credential issued/issued-api node-2 on the hub to see why). Kept the one this machine has.");
  expect((await node("issued", "use")).output).toBe("http://127.0.0.1:4600 key-2-for-node-2");
});

const nodeCredential = (home: string) => join(home, ".config/fleet/secrets/issued/credential.issued-api");

test("a stored credential that other users can read, or a link, is replaced by the pulled one, and apply goes on", async () => {
  const { hub, node, nodeHome } = linkedFleets(temp);
  await hub("apply");
  await node("apply");
  const file = nodeCredential(nodeHome);

  chmodSync(file, 0o644);
  const loose = await node("apply");
  expect(loose.code).toBe(0);
  expect(loose.output).not.toContain("Could not pull");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect((await node("issued", "use")).output).toBe("http://127.0.0.1:4600 key-3-for-node-2");

  const elsewhere = join(nodeHome, "elsewhere");
  writeFileSync(elsewhere, "not a credential", { mode: 0o600 });
  renameSync(file, `${file}.old`);
  symlinkSync(elsewhere, file);
  const linked = await node("apply");
  expect(linked.code).toBe(0);
  expect(linked.output).not.toContain("Could not pull");
  expect(lstatSync(file).isSymbolicLink()).toBe(false);
  expect(readFileSync(elsewhere, "utf8")).toBe("not a credential");
  expect((await node("issued", "use")).output).toBe("http://127.0.0.1:4600 key-4-for-node-2");
});

test("when the hub does not answer and the stored credential is open to other users, the finding says how to fix the file", async () => {
  const { hub, node, nodeHome, hosts } = linkedFleets(temp);
  await hub("apply");
  await node("apply");
  chmodSync(nodeCredential(nodeHome), 0o640);
  hosts["hub-1"] = "down";
  const down = await node("apply");
  expect(down.code).toBe(0);
  expect(down.output).toContain("Fix: Could not pull the credential of issued/issued-api from the hub hub-1 (ssh exited 255. Run ssh hub-1 true to see why). ~/.config/fleet/secrets/issued/credential.issued-api is open to other users. Run chmod 600 ~/.config/fleet/secrets/issued/credential.issued-api, or save the secret again.");
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

test("a pull's finding copies nothing that the hub printed, so a key that a service prints or throws stays on the hub", async () => {
  const { hub, node } = linkedFleets(temp);
  await hub("apply");
  await node("apply");
  await hub("issued", "leak");
  const leaked = await node("apply");
  expect(leaked.output).toContain("Fix: Could not pull the credential of issued/issued-api from the hub hub-1 (fleet credential exited 1 there. Run fleet credential issued/issued-api node-2 on the hub to see why). Kept the one this machine has.");
  expect(leaked.output).not.toContain(leakedKey);
});

test("a pull's finding names only the exit code, and for 255 points at ssh", async () => {
  const { hub, node, hosts } = linkedFleets(temp);
  await hub("apply");
  await node("apply");
  const reason = async (code: number) => {
    hosts["hub-1"] = async () => ({ code, stdout: "", stderr: "fleet: leaked-key\nleaked-key\n" });
    const { output } = await node("apply");
    expect(output).not.toContain("leaked-key");
    return output.match(/hub-1 \((.*)\)\. Kept/)?.[1];
  };
  expect(await reason(255)).toBe("ssh exited 255. Run ssh hub-1 true to see why");
  expect(await reason(137)).toBe("fleet credential exited 137 there. Run fleet credential issued/issued-api node-2 on the hub to see why");
});

test("fleet credential on the hub prints only the key for a node that the profile names, and what the service says goes to standard error", async () => {
  const { hub, hubFleet } = linkedFleets(temp);
  await hub("apply");
  expect(await hubFleet(["credential", "issued/issued-api", "node-2"])).toEqual({ code: 0, stdout: "key-2-for-node-2\n", stderr: "Issuing a key for node-2\n" });
});

test("a Mac on a profile with a hub pulls its credential from the hub at apply, though no devbox list names it", async () => {
  const { hub, mac: macOf } = linkedFleets(temp);
  const mac = macOf();
  await hub("apply");
  const applied = await mac("apply");
  expect(applied.code).toBe(0);
  expect(applied.output).not.toContain("Could not pull");
  expect(await mac("issued", "use")).toEqual({ code: 0, output: "http://127.0.0.1:4600 key-2-for-laptop-3" });
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
