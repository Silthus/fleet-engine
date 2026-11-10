import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { startT3Stub } from "../integrations/t3/testing.ts";
import { tempDirs } from "../testing/git.ts";

const temp = tempDirs();
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  temp.cleanup();
});

const repoRoot = join(import.meta.dir, "../..");
const start = Date.parse("2026-11-10T08:00:00Z");

async function machine(packs = ["kit"], settings: Record<string, string> = {}) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/kit"), join(engine, "packs/kit"), { recursive: true });
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs, plan: "claude", settings, workflows: {} }));
  const home = temp.make("home-");
  let now = start;
  let lines: string[] = [];
  const fleet = async (...args: string[]) => {
    lines = [];
    const code = await main(args, { home, engineRoot: engine, platform: "linux", env: {}, print: (line) => lines.push(line), run: async () => 0, clock: { now: () => now, sleep: async (ms) => void (now += ms) } });
    return { code, lines };
  };
  expect((await fleet("apply", "--profile", profile)).code).toBe(0);
  return { home, engine, fleet };
}

test("a pack.ts command runs in the engine with the pack's settings", async () => {
  expect(await (await machine()).fleet("kit", "greet", "you")).toEqual({ code: 0, lines: ["hello you"] });
  expect(await (await machine(["kit"], { "kit.greeting": "hi" })).fleet("kit", "greet", "you")).toEqual({ code: 0, lines: ["hi you"] });
});

test("a pack.ts command sees today's pack-command environment", async () => {
  const { home, engine, fleet } = await machine();
  const [line] = (await fleet("kit", "env")).lines;
  expect(line).toStartWith(`${home} ${engine} `);
  expect(JSON.parse(line!.split(" ").slice(2).join(" "))).toMatchObject({ "kit.greeting": "hello" });
});

test("a pack's secrets live in an owner-only store, and a write replaces the value whole", async () => {
  const { home, fleet } = await machine();
  expect((await fleet("kit", "show", "token")).lines).toEqual(["no secret"]);
  expect((await fleet("kit", "save", "token", "first")).code).toBe(0);
  expect((await fleet("kit", "save", "token", "second")).code).toBe(0);
  expect((await fleet("kit", "show", "token")).lines).toEqual(["second"]);
  const dir = join(home, ".config/fleet/secrets/kit");
  expect(readdirSync(dir)).toEqual(["token"]);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
});

test("a write closes a store directory that was left open to others", async () => {
  const { home, fleet } = await machine();
  const dir = join(home, ".config/fleet/secrets/kit");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  expect((await fleet("kit", "save", "token", "value")).code).toBe(0);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("a secret's name cannot leave the pack's store", async () => {
  const { home, fleet } = await machine();
  expect(await fleet("kit", "save", "../escape", "value")).toEqual({ code: 1, lines: ['fleet: a secret\'s name is lowercase words joined by dashes or dots, not "../escape"'] });
  expect(existsSync(join(home, ".config/fleet/secrets/escape"))).toBe(false);
});

test("fleet run runs a service body on the context's clock, never on real time", async () => {
  const { home, fleet } = await machine();
  expect(await fleet("run", "kit/kit-ticker")).toEqual({ code: 0, lines: ["2026-11-10T08:00:00.000Z tick 1", "2026-11-10T08:01:00.000Z tick 2", "2026-11-10T08:02:00.000Z tick 3"] });
  expect(readFileSync(join(home, ".local/state/fleet/kit/ticked"), "utf8")).toBe(String(Date.parse("2026-11-10T08:03:00Z")));
});

test("a pack.ts command cannot read a setting that its pack did not declare", async () => {
  expect(await (await machine()).fleet("kit", "stray")).toEqual({ code: 1, lines: ["fleet: ctx.get names a setting that the kit pack did not declare"] });
});

test("fleet run tests a check: it exits 1 until the check passes, then 0", async () => {
  const { fleet } = await machine();
  expect((await fleet("run", "kit/kit-saved")).code).toBe(1);
  await fleet("kit", "save", "token", "value");
  expect((await fleet("run", "kit/kit-saved")).code).toBe(0);
});

test("fleet run refuses an item that no pack you turned on declares", async () => {
  const { fleet } = await machine([]);
  expect(await fleet("run", "kit/kit-ticker")).toEqual({ code: 2, lines: ["fleet run: your packs have no service or check kit/kit-ticker"] });
  expect((await fleet("run", "kit")).code).toBe(2);
});

test("fleet run refuses an item that does not run on this machine, and a name that only every object has", async () => {
  const { fleet } = await machine();
  expect(await fleet("run", "kit/kit-extra-run")).toEqual({ code: 2, lines: ["fleet run: kit/kit-extra-run does not run here: workflow kit-extra is off"] });
  expect(await fleet("run", "kit/toString")).toEqual({ code: 2, lines: ["fleet run: your packs have no service or check kit/toString"] });
});

test("a pack.ts command leaves the engine's environment as it found it, also when it fails", async () => {
  const { fleet } = await machine();
  const saved = { settings: process.env.FLEET_SETTINGS, handlers: process.env.FLEET_HANDLERS };
  process.env.FLEET_SETTINGS = "before";
  delete process.env.FLEET_HANDLERS;
  try {
    expect((await fleet("kit", "env")).code).toBe(0);
    expect([process.env.FLEET_SETTINGS, process.env.FLEET_HANDLERS]).toEqual(["before", undefined]);
    expect(await fleet("kit", "fail")).toEqual({ code: 1, lines: ["fleet: kit failed"] });
    expect([process.env.FLEET_SETTINGS, process.env.FLEET_HANDLERS]).toEqual(["before", undefined]);
  } finally {
    for (const [key, value] of [["FLEET_SETTINGS", saved.settings], ["FLEET_HANDLERS", saved.handlers]] as const) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
});

test("ctx.threads starts a T3 thread from the plan's model table, once per key", async () => {
  let launched = 0;
  const t3 = await startT3Stub({
    shell: { projects: [], threads: [] },
    environmentId: "env-1",
    rpc(tag) {
      if (tag === "projects.ensureScratch") return { projectId: "scratch" };
      if (tag === "orchestration.launchThread") return { threadId: `thread-${++launched}` };
    },
  });
  stops.push(() => t3.stop());
  const { home, fleet } = await machine();
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  cpSync(join(t3.home, ".t3/userdata/server-runtime.json"), join(home, ".t3/userdata/server-runtime.json"));
  expect((await fleet("kit", "start", "key-1")).lines).toEqual(["https://app.t3.codes/threads/env-1/thread-1"]);
  expect((await fleet("kit", "start", "key-1")).lines).toEqual(["https://app.t3.codes/threads/env-1/thread-1"]);
  expect(t3.threads).toEqual([expect.objectContaining({ id: "thread-1", modelSelection: expect.objectContaining({ instanceId: "claudeAgent" }) })]);
});
