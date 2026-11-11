import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secretStore } from "./context.ts";
import { main, type CliOptions } from "../cli.ts";
import { startT3Stub } from "../integrations/t3/testing.ts";
import { tempDirs } from "../testing/git.ts";
import { engineSteps } from "../testing/packs.ts";

const temp = tempDirs();
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  temp.cleanup();
});

const repoRoot = join(import.meta.dir, "../..");
const start = Date.parse("2026-11-10T08:00:00Z");

async function spawned(command: string[], env: Record<string, string>) {
  try {
    return await Bun.spawn(command, { env, stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    return 127;
  }
}

async function machine(packs = ["kit"], settings: Record<string, string> = {}, files: Record<string, string> = {}) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/kit"), join(engine, "packs/kit"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(engine, path, ".."), { recursive: true });
    writeFileSync(join(engine, path), text);
  }
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs, plan: "claude", settings, workflows: {} }));
  const home = temp.make("home-");
  const bin = temp.make("bin-");
  for (const [tool, version] of [["claude", "claude 1.0.0"], ["npx", "11.0.0"]]) {
    writeFileSync(join(bin, tool!), `#!/bin/sh\n[ "$*" = --version ] && echo "${version}"\n`);
    chmodSync(join(bin, tool!), 0o755);
  }
  let now = start;
  let asleep = async (_now: number) => {};
  let lines: string[] = [];
  const options: CliOptions = {
    home,
    engineRoot: engine,
    platform: "linux",
    env: {},
    print: (line) => lines.push(line),
    run: engineSteps(engine, (args) => main(args, { ...options, print: () => {} }), (command) => spawned(command, { HOME: home, PATH: `${bin}:/usr/bin:/bin` })),
    clock: { now: () => now, sleep: async (ms) => ((now += ms), await asleep(now)) },
  };
  const fleet = async (...args: string[]) => {
    lines = [];
    const code = await main(args, options);
    return { code, lines };
  };
  expect((await fleet("apply", "--profile", profile)).code).toBe(0);
  return { home, engine, fleet, whileAsleep: (work: (now: number) => Promise<void>) => (asleep = work) };
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
  const files = readdirSync(dir).map((name) => join(dir, name));
  expect(files.filter((file) => readFileSync(file, "utf8").includes("first"))).toEqual([]);
  expect([statSync(dir).mode & 0o777, ...new Set(files.map((file) => statSync(file).mode & 0o777))]).toEqual([0o700, 0o600]);
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

test("fleet run holds a service quietly until the check it waits for passes, testing it every minute", async () => {
  const { home, fleet, whileAsleep } = await machine();
  whileAsleep(async (now) => {
    if (now >= start + 150_000) await secretStore(home, "kit").write("token", "value");
  });
  expect(await fleet("run", "kit/kit-sender")).toEqual({ code: 0, lines: ["fleet run: kit/kit-sender waits until kit-saved passes. Save the token.", "sent at 2026-11-10T08:03:00.000Z"] });
  expect(await fleet("run", "kit/kit-sender")).toEqual({ code: 0, lines: ["sent at 2026-11-10T08:03:00.000Z"] });
});

test("fleet run takes everything after the first slash as the id", async () => {
  const { fleet } = await machine();
  expect(await fleet("run", "kit/kit-saved/extra")).toEqual({ code: 2, lines: ["fleet run: your packs have no service or check kit/kit-saved/extra"] });
});

test("ctx.get names the workflow that is off when a setting only that workflow uses has no value here", async () => {
  const { fleet } = await machine(["kit"], { "kit.note": "remember" });
  expect(await fleet("kit", "note")).toEqual({ code: 1, lines: ["fleet: kit.note belongs to the Kit extra workflow, which is off. Turn it on with fleet packs --workflows kit-extra=on."] });
});

test("ctx.get asks for the value, not for an off workflow, when a workflow that is on also uses the setting", async () => {
  const kit = readFileSync(join(import.meta.dir, "fixtures/kit/pack.ts"), "utf8");
  const notes = 'fleet.workflow({ id: "kit-notes", name: "Kit notes", sentence: "The kit keeps notes.", default: true, settings: [note] });\n    const extra =';
  const variant = kit.replace('question: "Which note?" }', 'question: "Which note?", optional: true }').replace("const extra =", notes);
  const { fleet } = await machine(["kit"], {}, { "packs/kit/pack.ts": variant });
  expect(await fleet("kit", "note")).toEqual({ code: 1, lines: ["fleet: kit.note has no value. Set it with fleet set kit.note=<value>."] });
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
  expect(t3.threads).toEqual([{ id: "thread-1", title: "Kit", prompt: "Say hello.", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] } }]);
});

test("ctx.threads keeps the keys of two packs apart, so each pack gets its own thread", async () => {
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
  const kin = `export default { sdk: 1, name: "kin", summary: "A second pack.", register(fleet) { fleet.command("kin", { summary: "Start", run: async ([key], ctx) => (ctx.print((await ctx.threads.start({ key, title: "Kin", prompt: "Say hi.", modelRole: "implementation" })).id), 0) }); } };\n`;
  const { home, fleet } = await machine(["kit", "kin"], {}, { "packs/kin/pack.ts": kin });
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  cpSync(join(t3.home, ".t3/userdata/server-runtime.json"), join(home, ".t3/userdata/server-runtime.json"));
  await fleet("kit", "start", "same-key");
  await fleet("kin", "same-key");
  expect(t3.threads.map((thread) => thread.title)).toEqual(["Kit", "Kin"]);
});
