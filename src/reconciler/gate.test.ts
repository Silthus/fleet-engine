import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobsAdapter } from "../adapters/jobs/adapter.ts";
import { main, type CliOptions } from "../cli.ts";
import { tempDirs } from "../testing/git.ts";
import { filesAdapter } from "./apply.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "../..");

function machine() {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/gated"), join(engine, "packs/gated"), { recursive: true });
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
  return { home, profile, fleet, unit };
}

const todo = "The gated service needs its token. Run: fleet gated setup";

test("a service whose check fails gets no unit, and its setup command installs it in the same run", async () => {
  const { profile, fleet, unit } = machine();
  const first = await fleet("apply", "--profile", profile);
  expect(first.lines.join("\n")).toContain(todo);
  expect(existsSync(unit)).toBe(false);
  expect((await fleet("gated", "setup")).code).toBe(0);
  expect(existsSync(unit)).toBe(true);
  expect((await fleet("doctor")).lines.join("\n")).not.toContain(todo);
});

test("a check that stops passing removes the unit, and doctor names the check as a To do once", async () => {
  const { home, profile, fleet, unit } = machine();
  await fleet("apply", "--profile", profile);
  await fleet("gated", "setup");
  expect(existsSync(unit)).toBe(true);
  rmSync(join(home, ".config/fleet/secrets/gated/token"));
  const doctor = await fleet("doctor");
  expect(doctor.code).toBe(1);
  expect(doctor.lines.join("\n").split(todo).length).toBe(2);
  expect(existsSync(unit)).toBe(true);
  await fleet("apply");
  expect(existsSync(unit)).toBe(false);
});

test("a setup command that fails applies nothing, even when it saved the token", async () => {
  const { home, profile, fleet, unit } = machine();
  await fleet("apply", "--profile", profile);
  mkdirSync(join(home, ".config/fleet/secrets/gated"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/secrets/gated/broken"), "yes");
  expect((await fleet("gated", "setup")).code).toBe(1);
  expect(existsSync(unit)).toBe(false);
});
