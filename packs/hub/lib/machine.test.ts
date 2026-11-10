import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { hubCallLimitMs, peerMachine, peerSsh, peersOf, profileDevboxes, quote, readBoxSettings, remoteFleet, requireHub, shellLimitMs, shellsWith, thisMachine } from "./machine.ts";
import type { Capture } from "./coder.ts";
import { fakeSsh, type Host } from "../../../src/testing/ssh.ts";
import { boxSettings } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function homeWithMachine(machine?: Record<string, unknown>) {
  const home = temp.make("fleet-hub-");
  if (machine) {
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify(machine));
  }
  return home;
}

test("box settings come from the hub.* settings, with the kept folders split on spaces and no warm command when unset", () => {
  const settings = readBoxSettings({ FLEET_SETTINGS: JSON.stringify(boxSettings) });
  expect(settings).toEqual({ alias: "my-hub", coderUrl: "https://coder.example.com", template: "linux-box", diskGigabytes: 120, poolSize: 4, idleHours: 4, reapDays: 3, keepDirs: ["notes", "tools"], relayPort: 60001 });
  expect(readBoxSettings({ FLEET_SETTINGS: JSON.stringify({ ...boxSettings, "hub.boxWarmCommand": "make warm" }) }).warmCommand).toBe("make warm");
});

test("every peer is the hub plus the profile's devboxes, without this machine and without repeats", () => {
  expect(peersOf("my-hub", ["devbox-1", "devbox-2", "my-hub"], "devbox-1")).toEqual(["my-hub", "devbox-2"]);
  expect(peersOf("my-hub", ["devbox-1"], "my-hub")).toEqual(["devbox-1"]);
});

test("a hub-only command refuses on a machine that is not the hub and says how to fix it", () => {
  expect(() => requireHub(homeWithMachine({ schema: 1, role: "devbox" }), "sweep")).toThrow("fleet box sweep runs only on the hub. This machine's role is devbox. Run fleet hub here on the hub");
  expect(() => requireHub(homeWithMachine({ schema: 1, role: "hub" }), "sweep")).not.toThrow();
});

test("peers and nightly grants cover the devboxes in the profile and those fleet devbox add saved in machine.json, once each", () => {
  const home = homeWithMachine({ schema: 1, role: "hub", devboxes: ["devbox-3", "devbox-2"] });
  const profile = temp.make("fleet-profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ devboxes: ["devbox-2"] }));
  const machine = thisMachine({ FLEET_SETTINGS: JSON.stringify(boxSettings), FLEET_PROFILE_DIR: profile }, home);
  expect(machine.devboxes).toEqual(["devbox-2", "devbox-3"]);
  expect(machine.peers).toEqual(["devbox-2", "devbox-3"]);
  const withoutProfile = thisMachine({ FLEET_SETTINGS: JSON.stringify(boxSettings) }, home);
  expect(withoutProfile.devboxes).toEqual(["devbox-3", "devbox-2"]);
});

test("a profile devbox dials the hub itself only while the profile names a hub, and a box never does", () => {
  const profile = temp.make("fleet-profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ hub: "my-hub", devboxes: ["devbox-2", "box-lane", "my-hub"] }));
  expect(profileDevboxes({ FLEET_PROFILE_DIR: profile })).toEqual(["devbox-2"]);
});

test("a profile that names no hub has no devbox that dials the hub, so the hub's tunnels keep the gateway port", () => {
  const profile = temp.make("fleet-profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ devboxes: ["devbox-2"] }));
  expect(profileDevboxes({ FLEET_PROFILE_DIR: profile })).toEqual([]);
  expect(profileDevboxes({})).toEqual([]);
});

test("the peer list needs only hub.alias, so Hub links works without the Boxes settings", () => {
  const home = homeWithMachine({ schema: 1, role: "devbox", devboxes: ["devbox-3", "devbox-2"] });
  const profile = temp.make("fleet-profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ devboxes: ["devbox-2", "devbox-4"] }));
  const here = peerMachine({ FLEET_SETTINGS: JSON.stringify({ "hub.alias": "my-hub" }), FLEET_PROFILE_DIR: profile }, home, "devbox-4");
  expect(here.devboxes).toEqual(["devbox-2", "devbox-4", "devbox-3"]);
  expect(here.peers).toEqual(["my-hub", "devbox-2", "devbox-3"]);
  expect(here.self).toBe("devbox-4");
});

test("a box in the devbox list is never a peer, whether the profile or the machine file names it", () => {
  const home = homeWithMachine({ schema: 1, role: "devbox", devboxes: ["box-saved"] });
  const profile = temp.make("fleet-profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ devboxes: ["devbox-2", "box-lane"] }));
  const here = peerMachine({ FLEET_SETTINGS: JSON.stringify({ "hub.alias": "my-hub" }), FLEET_PROFILE_DIR: profile }, home, "devbox-4");
  expect(here.devboxes).toEqual(["devbox-2", "box-lane", "box-saved"]);
  expect(here.peers).toEqual(["my-hub", "devbox-2"]);
});

test("every SSH command to a peer turns agent forwarding off, whatever the person's own SSH config says", () => {
  expect(peerSsh("box-1", "echo hi")).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=10", "box-1", "bash -lc 'echo hi'"]);
});

test("the hub never lists itself as a peer when its SSH alias differs from its host name, and a devbox leaves out the name its machine file records", () => {
  const settings = { FLEET_SETTINGS: JSON.stringify({ "hub.alias": "my-hub" }) };
  const hubHome = homeWithMachine({ schema: 1, role: "hub", devboxes: ["devbox-2"] });
  expect(peerMachine(settings, hubHome, "hub-host").peers).toEqual(["devbox-2"]);
  const devboxHome = homeWithMachine({ schema: 1, role: "devbox", name: "devbox-4", devboxes: ["devbox-4", "devbox-2"] });
  expect(peerMachine(settings, devboxHome, "ip-10-0-0-4").peers).toEqual(["my-hub", "devbox-2"]);
  const unnamed = homeWithMachine({ schema: 1, role: "devbox", devboxes: ["devbox-2"] });
  expect(peerMachine(settings, unnamed, "devbox-9").peers).toEqual(["my-hub", "devbox-2"]);
});

test("every call to a peer over SSH and every local command gets an operation time limit, so a hanging call cannot hang a box command", async () => {
  const asked: Array<{ argv: string[]; timeoutMs: number; stdin?: string }> = [];
  const capture: Capture = async (argv, options) => (asked.push({ argv, timeoutMs: options.timeoutMs, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) }), { code: 0, stdout: "", stderr: "" });
  const { onPeer, run } = shellsWith(capture, "my-hub");
  await onPeer("my-hub", "fleet box pool list", "input");
  await run(["systemctl", "--user", "is-active", "unit"]);
  expect(asked).toEqual([
    { argv: ["ssh", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=10", "my-hub", "bash -lc 'fleet box pool list'"], timeoutMs: shellLimitMs, stdin: "input" },
    { argv: ["systemctl", "--user", "is-active", "unit"], timeoutMs: shellLimitMs },
  ]);
  expect(shellLimitMs).toBeGreaterThan(0);
});

const loginShells = ["sh", "bash", "zsh"].filter((shell) => Bun.which(shell));

test("a devbox hands a box operation to the hub in one batch SSH call, with each word kept whole in the hub's login shell, and gives back the hub's exit code", async () => {
  for (const shell of loginShells) {
    const heard: string[][] = [];
    const hub: Host = async (args) => (heard.push(args), { code: 3, stdout: "", stderr: "" });
    const { toHub } = shellsWith(fakeSsh(temp.make("fleet-remote-"), { "my-hub": hub }, shell) as Capture, "my-hub");
    const words = ["box", "spawn", "Lane 7; rm -rf ~", "=printf", "--for", "devbox-1"];
    expect(await toHub(words)).toBe(3);
    expect(heard).toEqual([words]);
  }
});

test("a hub call may run longer than a shell call", () => {
  expect(hubCallLimitMs).toBeGreaterThan(shellLimitMs);
});
