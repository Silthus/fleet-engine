import { afterEach, expect, test } from "bun:test";
import { tempDirs } from "../testing/git.ts";
import { linkedFleets } from "../testing/linked.ts";

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

test("when the hub connects but never answers, the pull gives up at its deadline and the node keeps its stored credential", async () => {
  let lapsed = false;
  const slept: number[] = [];
  const { hub, node, hosts } = linkedFleets(temp, undefined, { now: Date.now, sleep: (ms) => (lapsed ? (slept.push(ms), Promise.resolve()) : new Promise(() => {})) });
  await hub("apply");
  expect((await node("apply")).output).not.toContain("Could not pull");
  hosts["hub-1"] = () => new Promise(() => {});
  lapsed = true;
  const stuck = await node("apply");
  expect(stuck.code).toBe(0);
  expect(stuck.output).toContain("Fix: Could not pull the credential of issued/issued-api from the hub hub-1 (it did not answer within 90 seconds). Kept the one this machine has.");
  expect(slept).toEqual([90_000]);
  expect((await node("issued", "use")).output).toBe("http://127.0.0.1:4600 key-2-for-node-2");
});

test("a pull's finding names the hub's own error and never what the service logged", async () => {
  const { hub, node, hosts } = linkedFleets(temp);
  await hub("apply");
  await node("apply");

  hosts["hub-1"] = async () => ({ code: 137, stdout: "", stderr: "Issuing key-9-for-node-2\n" });
  const killed = await node("apply");
  expect(killed.output).toContain("Fix: Could not pull the credential of issued/issued-api from the hub hub-1 (exit 137). Kept the one this machine has.");
  expect(killed.output).not.toContain("key-9");

  hosts["hub-1"] = async () => ({ code: 1, stdout: "", stderr: "Issuing key-9-for-node-2\nfleet: the service said no\nkey-9-for-node-2\n" });
  const refused = await node("apply");
  expect(refused.output).toContain("(fleet: the service said no)");
  expect(refused.output).not.toContain("key-9");

  hosts["hub-1"] = async () => ({ code: 127, stdout: "", stderr: "sh: 1: fleet: not found\n" });
  expect((await node("apply")).output).toContain("(sh: 1: fleet: not found)");
});

test("fleet credential on the hub prints only the key for a node that the profile names, and what the service says goes to standard error", async () => {
  const { hub, hubFleet } = linkedFleets(temp);
  await hub("apply");
  expect(await hubFleet(["credential", "issued/issued-api", "node-2"])).toEqual({ code: 0, stdout: "key-2-for-node-2\n", stderr: "Issuing a key for node-2\n" });
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
