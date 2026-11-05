import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { hubCommand, markHub, peersOf, readBoxSettings, readRole, requireHub, shellLimitMs, shellsWith, thisMachine } from "./machine.ts";
import type { Capture } from "./coder.ts";
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

test("fleet hub here marks this machine as the hub and keeps every other machine field", async () => {
  const home = homeWithMachine({ schema: 1, role: "devbox", coder: true, profileDir: "/profile", devboxes: ["devbox-2"], setup: { done: ["a"] } });
  const lines: string[] = [];
  expect(await hubCommand(["here"], { home, settings: boxSettings, print: (line) => lines.push(line) })).toBe(0);
  expect(JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8"))).toEqual({ schema: 1, role: "hub", coder: true, profileDir: "/profile", devboxes: ["devbox-2"], setup: { done: ["a"] } });
  expect(readdirSync(join(home, ".config/fleet"))).toEqual(["machine.json"]);
  expect(readRole(home)).toBe("hub");
});

test("fleet hub here refuses without a machine file, because setup writes it", async () => {
  const home = homeWithMachine();
  await expect(markHub(home)).rejects.toThrow("fleet setup");
  expect(existsSync(join(home, ".config/fleet/machine.json"))).toBe(false);
});

test("fleet hub status prints this machine's role and the hub.alias setting", async () => {
  const home = homeWithMachine({ schema: 1, role: "devbox" });
  const lines: string[] = [];
  expect(await hubCommand(["status"], { home, settings: boxSettings, print: (line) => lines.push(line) })).toBe(0);
  expect(lines).toEqual(["This machine's role: devbox", "hub.alias: my-hub"]);
  expect(await hubCommand(["elsewhere"], { home, settings: {}, print: (line) => lines.push(line) })).toBe(2);
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
  expect(machine.peers).toEqual(["my-hub", "devbox-2", "devbox-3"]);
  const withoutProfile = thisMachine({ FLEET_SETTINGS: JSON.stringify(boxSettings) }, home);
  expect(withoutProfile.devboxes).toEqual(["devbox-3", "devbox-2"]);
});

test("fleet hub here never writes through a file planted at a temporary name", async () => {
  const home = homeWithMachine({ schema: 1, role: "devbox" });
  const path = join(home, ".config/fleet/machine.json");
  writeFileSync(join(home, "victim"), "keep\n");
  symlinkSync(join(home, "victim"), `${path}.${process.pid}.partial`);
  await markHub(home);
  expect(readFileSync(join(home, "victim"), "utf8")).toBe("keep\n");
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
  expect(readRole(home)).toBe("hub");
});

test("every call to a peer over SSH and every local command gets an operation time limit, so a hanging call cannot hang a box command", async () => {
  const asked: Array<{ argv: string[]; timeoutMs: number; stdin?: string }> = [];
  const capture: Capture = async (argv, options) => (asked.push({ argv, timeoutMs: options.timeoutMs, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) }), { code: 0, stdout: "", stderr: "" });
  const { onPeer, run } = shellsWith(capture);
  await onPeer("my-hub", "fleet box pool list", "input");
  await run(["systemctl", "--user", "is-active", "unit"]);
  expect(asked).toEqual([
    { argv: ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "my-hub", "bash -lc 'fleet box pool list'"], timeoutMs: shellLimitMs, stdin: "input" },
    { argv: ["systemctl", "--user", "is-active", "unit"], timeoutMs: shellLimitMs },
  ]);
  expect(shellLimitMs).toBeGreaterThan(0);
});
