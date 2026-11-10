import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobsAdapter } from "../adapters/jobs/adapter.ts";
import { main, type CliOptions } from "../cli.ts";
import { tempDirs } from "../testing/git.ts";
import { filesAdapter } from "./apply.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "../..");

function machine(repair = "fleet gated setup") {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/gated"), join(engine, "packs/gated"), { recursive: true });
  const pack = join(engine, "packs/gated/pack.ts");
  writeFileSync(pack, readFileSync(pack, "utf8").replace('command: "fleet gated setup"', `command: ${JSON.stringify(repair)}`));
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["gated"], plan: "claude", settings: {}, workflows: {} }));
  const home = temp.make("home-");
  const engineFleet = join(engine, "fleet");
  let lines: string[] = [];
  const options: CliOptions = {
    home,
    engineRoot: engine,
    platform: "linux",
    env: {},
    print: (line) => lines.push(line),
    run: async (command) => (command[0] === "/bin/sh" && command[1] === engineFleet ? main(command.slice(2), { ...options, print: () => {} }) : 0),
    adapters: () => [filesAdapter, jobsAdapter({ run: async () => ({ code: 0, stdout: "" }), engineRoot: engine })],
  };
  const fleet = async (...args: string[]) => {
    lines = [];
    return { code: await main(args, options), lines };
  };
  const unit = join(home, ".config/systemd/user/fleet-gated-worker.service");
  return { profile, fleet, unit };
}

const todo = "The gated service needs its token. Run: fleet gated setup";

test("a service whose check fails gets no unit, and its setup command installs it in the same run", async () => {
  const { profile, fleet, unit } = machine();
  const first = await fleet("apply", "--profile", profile);
  expect(first.code).toBe(0);
  expect(first.lines.join("\n")).toContain(todo);
  expect(existsSync(unit)).toBe(false);
  expect((await fleet("gated", "setup")).code).toBe(0);
  expect(existsSync(unit)).toBe(true);
  expect((await fleet("doctor")).lines.join("\n")).not.toContain(todo);
});

test("a check that stops passing removes the unit, and doctor names the check as a To do once", async () => {
  const { profile, fleet, unit } = machine();
  await fleet("apply", "--profile", profile);
  await fleet("gated", "setup");
  expect(existsSync(unit)).toBe(true);
  expect((await fleet("gated", "forget")).code).toBe(0);
  const doctor = await fleet("doctor");
  expect(doctor.code).toBe(1);
  expect(doctor.lines.join("\n").split(todo).length).toBe(2);
  expect(existsSync(unit)).toBe(true);
  await fleet("apply");
  expect(existsSync(unit)).toBe(false);
});

test("a setup command that fails applies nothing, even when it saved the token", async () => {
  const { profile, fleet, unit } = machine();
  await fleet("apply", "--profile", profile);
  expect((await fleet("gated", "break")).code).toBe(0);
  expect((await fleet("gated", "setup")).code).toBe(1);
  expect(existsSync(unit)).toBe(false);
});

test("a check that stops passing removes the unit even while another source is unreachable", async () => {
  const { profile, fleet, unit } = machine();
  await fleet("apply", "--profile", profile);
  await fleet("gated", "setup");
  expect(existsSync(unit)).toBe(true);
  const unreachable = { name: "team", repo: join(temp.make("gone-"), "team"), ref: "main" };
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [unreachable], packs: ["gated", "team"], plan: "claude", settings: {}, workflows: {} }));
  await fleet("gated", "forget");
  expect((await fleet("apply")).lines.join("\n")).toContain(todo);
  expect(existsSync(unit)).toBe(false);
});

test("a repair command matches the words you type, however the pack spaces them", async () => {
  const { profile, fleet, unit } = machine("fleet  gated   setup");
  await fleet("apply", "--profile", profile);
  expect((await fleet("gated", "setup")).code).toBe(0);
  expect(existsSync(unit)).toBe(true);
});
