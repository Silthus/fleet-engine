import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jobsAdapter } from "../adapters/jobs/adapter.ts";
import { main, type CliOptions } from "../cli.ts";
import type { CommandRunner } from "../adapters/run.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { engineSteps } from "../testing/packs.ts";
import { fakeSystemd } from "../testing/systemd.ts";
import { filesAdapter } from "./apply.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "../..");

function launchd() {
  const loaded = new Set<string>();
  const run: CommandRunner = async ([, verb, target, file]) => {
    if (verb === "print") return { code: loaded.has(target!) ? 0 : 113, stdout: "" };
    if (verb === "bootstrap") loaded.add(`gui/501/${file!.split("/").at(-1)!.replace(/\.plist$/, "")}`);
    if (verb === "bootout") loaded.delete(target!);
    return { code: 0, stdout: "" };
  };
  return { loaded, run };
}

function machine(repair = "fleet gated setup", platform: "linux" | "darwin" = "linux", extra: Record<string, string> = {}) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/gated"), join(engine, "packs/gated"), { recursive: true });
  const pack = join(engine, "packs/gated/pack.ts");
  writeFileSync(pack, readFileSync(pack, "utf8").replace('command: "fleet gated setup"', `command: ${JSON.stringify(repair)}`));
  for (const [file, text] of Object.entries(extra)) {
    mkdirSync(join(engine, "packs", dirname(file)), { recursive: true });
    writeFileSync(join(engine, "packs", file), text);
  }
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["gated", ...Object.keys(extra).map(dirname)], plan: "claude", settings: {}, workflows: {} }));
  const home = temp.make("home-");
  let lines: string[] = [];
  const mac = launchd();
  const linux = fakeSystemd();
  const options: CliOptions = {
    home,
    engineRoot: engine,
    platform,
    env: {},
    print: (line) => lines.push(line),
    run: engineSteps(engine, (args) => main(args, { ...options, print: () => {} })),
    adapters: () => [filesAdapter, jobsAdapter({ run: platform === "darwin" ? mac.run : linux.run, engineRoot: engine, uid: 501 })],
  };
  const fleet = async (...args: string[]) => {
    lines = [];
    return { code: await main(args, options), lines };
  };
  const service = (id: string) => {
    if (platform === "linux") return linux.service(home, id);
    const parts = [existsSync(join(home, `Library/LaunchAgents/dev.fleet.${id}.plist`)), mac.loaded.has(`gui/501/dev.fleet.${id}`)];
    return parts.every(Boolean) ? "running" : parts.some(Boolean) ? "partly removed" : "gone";
  };
  return { profile, home, fleet, service };
}

const todo = "The gated service needs its token. Run: fleet gated setup";

test("a service whose check fails gets no unit, and its setup command installs it in the same run", async () => {
  const { profile, fleet, service } = machine();
  const first = await fleet("apply", "--profile", profile);
  expect(first.code).toBe(0);
  expect(first.lines.join("\n")).toContain(todo);
  expect(service("gated-worker")).toBe("gone");
  expect((await fleet("gated", "setup")).code).toBe(0);
  expect(service("gated-worker")).toBe("running");
  expect((await fleet("doctor")).lines.join("\n")).not.toContain(todo);
});

test("a check that stops passing removes the unit, and doctor names the check as a To do once", async () => {
  const { profile, fleet, service } = machine();
  await fleet("apply", "--profile", profile);
  await fleet("gated", "setup");
  expect(service("gated-worker")).toBe("running");
  expect((await fleet("gated", "forget")).code).toBe(0);
  const doctor = await fleet("doctor");
  expect(doctor.code).toBe(1);
  expect(doctor.lines.join("\n").split(todo).length).toBe(2);
  expect(service("gated-worker")).toBe("running");
  await fleet("apply");
  expect(service("gated-worker")).toBe("gone");
});

test("a setup command that fails applies nothing, even when it saved the token", async () => {
  const { profile, fleet, service } = machine();
  await fleet("apply", "--profile", profile);
  expect((await fleet("gated", "break")).code).toBe(0);
  expect((await fleet("gated", "setup")).code).toBe(1);
  expect(service("gated-worker")).toBe("gone");
});

test.each(["linux", "darwin"] as const)("on %s, a check that stops passing removes its service while another source is out, and that source's service stays", async (platform) => {
  const { profile, home, fleet, service } = machine("fleet gated setup", platform);
  const repo = join(temp.make("team-"), "team");
  mkdirSync(join(repo, "packs/team"), { recursive: true });
  writeFileSync(join(repo, "packs/team/pack.json"), JSON.stringify({ schema: 1, name: "team", summary: "Team rules.", jobs: [{ id: "team-watch", command: ["fleet", "packs"], schedule: { every: "always" } }] }));
  await spawnGit(repo, "init", "-q", "-b", "main");
  await spawnGit(repo, "add", ".");
  await spawnGit(repo, "commit", "-q", "-m", "team");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [{ name: "team", repo, ref: "main" }], packs: ["gated", "team"], plan: "claude", settings: {}, workflows: {} }));
  await fleet("apply", "--profile", profile);
  await fleet("gated", "setup");
  expect([service("gated-worker"), service("team-watch")]).toEqual(["running", "running"]);
  rmSync(repo, { recursive: true, force: true });
  rmSync(join(home, ".local/share/fleet/sources/team"), { recursive: true, force: true });
  await fleet("gated", "forget");
  expect((await fleet("apply")).lines.join("\n")).toContain(todo);
  expect([service("gated-worker"), service("team-watch")]).toEqual(["gone", "running"]);
});

test("a pack.json sign-in command matches the words you type, however that pack spaces them", async () => {
  const spaced = JSON.stringify({ schema: 1, name: "spaced", summary: "Spaces its words.", human: [{ id: "save", say: "Save the token.", command: "fleet  gated   setup", probe: ["true"] }] });
  const { profile, fleet, service } = machine("fleet gated never", "linux", { "spaced/pack.json": spaced });
  await fleet("apply", "--profile", profile);
  expect((await fleet("gated", "setup")).code).toBe(0);
  expect(service("gated-worker")).toBe("running");
});

test("a repair command that another pack ships installs the service once it passes", async () => {
  const keeper = `export default { sdk: 1, name: "keeper", summary: "Keeps tokens.", register(fleet) { fleet.command("keeper", { summary: "Save", run: async () => { const dir = process.env.HOME + "/.config/fleet/secrets/gated"; await Bun.$\`mkdir -p \${dir}\`; await Bun.write(dir + "/token", "value"); return 0; } }); } };\n`;
  const { profile, fleet, service } = machine("fleet keeper save", "linux", { "keeper/pack.ts": keeper });
  await fleet("apply", "--profile", profile);
  expect(service("gated-worker")).toBe("gone");
  expect((await fleet("keeper", "save")).code).toBe(0);
  expect(service("gated-worker")).toBe("running");
});
