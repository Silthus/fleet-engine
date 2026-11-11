import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, type CliOptions } from "../cli.ts";
import type { MachineFile } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { engineSteps } from "../testing/packs.ts";
import { filesAdapter } from "./apply.ts";
import { leakedKey } from "./fixtures/issued/pack.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "../..");
const hub: MachineFile = { schema: 1, role: "linux", name: "hub-1" };
const node: MachineFile = { schema: 1, role: "devbox", coder: true, name: "node-2" };

function machine(saved: MachineFile) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/issued"), join(engine, "packs/issued"), { recursive: true });
  const home = temp.make("home-");
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["issued"], plan: "claude", settings: {}, workflows: {}, hub: "hub-1", devboxes: ["node-2"] }));
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ ...saved, profileDir: profile }));
  let lines: string[] = [];
  const options: CliOptions = {
    home,
    engineRoot: engine,
    platform: "linux",
    env: {},
    print: (line) => lines.push(line),
    hostname: () => saved.name!,
    run: engineSteps(engine, (args) => main(args, { ...options, print: () => {} })),
    adapters: () => [filesAdapter],
  };
  return async (...args: string[]) => {
    lines = [];
    const code = await main(args, options);
    return { code, output: lines.join("\n") };
  };
}

test("on the hub, apply runs the install repair, issues the hub's own key once, and ctx.use returns it with the loopback URL", async () => {
  const fleet = machine(hub);
  expect(await fleet("issued", "use")).toEqual({ code: 1, output: "fleet: issued/issued-api has no credential on this machine yet. Run fleet apply on the hub." });
  const first = await fleet("apply");
  expect(first.code).toBe(0);
  expect(first.output).not.toContain("not installed");
  expect(await fleet("issued", "use")).toEqual({ code: 0, output: "http://127.0.0.1:4600 key-1-for-hub-1" });
  expect((await fleet("apply")).code).toBe(0);
  expect(await fleet("issued", "use")).toEqual({ code: 0, output: "http://127.0.0.1:4600 key-1-for-hub-1" });
});

test("before apply runs its repair, a dry run and doctor name the failing check as a Fix, not a To do", async () => {
  const fleet = machine(hub);
  const previewed = await fleet("apply", "--dry-run");
  expect(previewed.output).toContain("Fix: The issued service is not installed.\n");
  expect(previewed.output).not.toContain("To do:");
  const doctored = await fleet("doctor");
  expect(doctored.output).toContain("Fix: The issued service is not installed.\n");
  expect(doctored.output).not.toContain("To do:");
});

test("a repair that fails leaves the check as a To do, and the hub issues no key for a service whose gate failed", async () => {
  const fleet = machine(hub);
  expect((await fleet("issued", "break")).code).toBe(0);
  const applied = await fleet("apply");
  expect(applied.code).toBe(0);
  expect(applied.output).toContain("To do: The issued service is not installed.\n");
  expect((await fleet("issued", "use")).output).toBe("fleet: issued/issued-api has no credential on this machine yet. Run fleet apply on the hub.");
});

test("a service that refuses to issue a key gives a finding, and apply stores nothing", async () => {
  const fleet = machine(hub);
  expect((await fleet("issued", "refuse")).code).toBe(0);
  const applied = await fleet("apply");
  expect(applied.output).toContain("Fix: Could not issue the credential of issued/issued-api. Run fleet credential issued/issued-api hub-1 to see why. Fleet tries again at the next apply.");
  expect(applied.code).toBe(0);
  expect((await fleet("issued", "use")).output).toBe("fleet: issued/issued-api has no credential on this machine yet. Run fleet apply on the hub.");
});

test("the hub's finding copies nothing that a failing service printed or threw, so its key stays out of the report", async () => {
  const fleet = machine(hub);
  expect((await fleet("issued", "leak")).code).toBe(0);
  const applied = await fleet("apply");
  const report = applied.output.split("\n").filter((line) => line !== `fleet: ${leakedKey}`).join("\n");
  expect(report).toContain("Fix: Could not issue the credential of issued/issued-api. Run fleet credential issued/issued-api hub-1 to see why. Fleet tries again at the next apply.");
  expect(report).not.toContain(leakedKey);
});

test("a node issues nothing in its own apply, and ctx.use fails fast with a sentence", async () => {
  const fleet = machine(node);
  expect((await fleet("apply")).code).toBe(0);
  expect(await fleet("issued", "use")).toEqual({ code: 1, output: "fleet: issued/issued-api has no credential on this machine yet. Run fleet apply on the hub." });
});

test("ctx.use names a service that the catalog leaves out because its workflow is off", async () => {
  const fleet = machine(hub);
  expect(await fleet("issued", "spare")).toEqual({ code: 1, output: "fleet: the service catalog has no issued/issued-spare: its workflow or plan is off in your profile." });
});
