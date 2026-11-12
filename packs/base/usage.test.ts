import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import { isolateGit, tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { fire, notes } from "../memory/recall-testing.ts";
import { flush } from "./lib/usage-flush.ts";

isolateGit();
const engineRoot = join(import.meta.dir, "../..");
const launcher = join(engineRoot, "fleet");
const temp = tempDirs();
afterEach(() => temp.cleanup());

const secret = () => ["sk", "ant", "api03", crypto.randomUUID().replaceAll("-", "")].join("-");
const projectKey = () => ["phc", "test", crypto.randomUUID().replaceAll("-", "")].join("_");
const spool = (home: string) => join(home, ".local/state/fleet/usage.jsonl");
const spooled = (home: string) => (existsSync(spool(home)) ? readFileSync(spool(home), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);

type Received = { path: string; body: { api_key: string; batch: Array<{ event: string; properties: Record<string, unknown> }> } };
const received: Received[] = [];
let answers: number[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    received.push({ path: new URL(request.url).pathname, body: await request.json() });
    return new Response("{}", { status: answers.shift() ?? 200 });
  } });
});
afterAll(() => server.stop(true));
afterEach(() => void (received.length = 0, answers = []));

async function fleet(args: string[], home: string, env: Record<string, string> = {}, interactive = false) {
  const runFleetSteps = async (command: string[], stepEnv: Record<string, string> = {}) => (command[1] === launcher ? (await fleet(command.slice(2), home, { FLEET_PROFILE_DIR: join(home, "profile"), ...stepEnv })).code : 0);
  const lines: string[] = [];
  const code = await main(args, { home, engineRoot, platform: "linux", env: { ...env }, print: (line) => lines.push(line), fail: (line) => lines.push(line), run: runFleetSteps, interactive });
  return { code, output: lines.join("\n") };
}

async function machine(packs: string[], settings: Record<string, string>, workflows: Record<string, boolean> = { "usage-events": true }) {
  const home = temp.make("home-");
  const profile = join(home, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [], packs, plan: "both", settings, workflows }));
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  symlinkSync(process.execPath, join(home, ".bun/bin/bun"));
  const applied = await fleet(["apply", "--profile", profile], home);
  expect(applied.code).toBe(0);
  return home;
}

const destination = (key = projectKey()) => ({ "base.usageHost": `http://127.0.0.1:${server.port}`, "base.usageProjectKey": key });

describe("the Usage events workflow", () => {
  test("is off by default, and once on flushes every five minutes and asks for a destination, since it has none by default", async () => {
    const engine = await engineSource();
    const sources = [engine, ...skillSources(temp.make("skills-"), engine)];
    const off = resolveEngine(sources, {}, devbox);
    expect(off.jobs.map((job) => job.id)).not.toContain("usage-flush");
    expect(Object.keys(off.settings).filter((key) => key.startsWith("base.usage"))).toEqual([]);
    const on = resolveEngine(sources, { workflows: { "usage-events": true } }, devbox);
    expect(on.jobs).toContainEqual(expect.objectContaining({ id: "usage-flush", command: ["fleet", "usage", "flush"], schedule: { every: "5m" } }));
    expect(on.unanswered.map((setting) => setting.key)).toEqual(["base.usageHost", "base.usageProjectKey"]);
  });

  test("a machine with the workflow off spools nothing, though the profile names a destination", async () => {
    const home = await machine(["memory"], { "memory.repo": "me/notes", ...destination() }, {});
    await fleet(["settings"], home);
    expect(existsSync(spool(home))).toBe(false);
    expect((await fleet(["usage", "flush"], home)).code).toBe(1);
    expect(received).toEqual([]);
  });
});

describe("usage events", () => {
  test("carry command names, plain subcommands, and counts, never arguments, prompts, file contents, or secrets", async () => {
    const key = projectKey();
    const home = await machine(["memory"], { "memory.repo": "me/notes", ...destination(key) });
    for (const [path, text] of Object.entries(notes)) {
      mkdirSync(join(home, ".agents/memory", path, ".."), { recursive: true });
      writeFileSync(join(home, ".agents/memory", path), text);
    }
    const token = secret();
    const prompt = `Please read /home/someone/customer-notes.md and use ${token}`;
    await fleet(["settings", token], home, { CLAUDECODE: "1" });
    await fleet(["run", "/home/someone/customer-notes.md"], home, {}, true);
    await fleet(["packs", "--add", prompt], home);
    await fleet([token], home);
    await fleet(["hub", "box4817"], home);
    await fleet(["devbox", "list"], home);
    await fleet(["settings-snapshot", "--check"], home);
    const recalled = await fire(home, "claude", "PreToolUse", { session_id: "s1", tool_name: "Bash", tool_input: { command: `fleet proof ${token} # ${prompt}` } });
    expect(recalled.context).toContain("Pass full SHAs");

    const events = spooled(home).map(({ event, properties }) => ({ event, ...properties }));
    expect(events.map(({ event, command, subcommand, notes: count, caller }) => ({ event, command, subcommand, notes: count, caller }))).toEqual([
      { event: "fleet command", command: "settings", subcommand: "", notes: undefined, caller: "agent" },
      { event: "fleet command", command: "run", subcommand: "", notes: undefined, caller: "person" },
      { event: "fleet command", command: "packs", subcommand: "", notes: undefined, caller: "job" },
      { event: "fleet command", command: "hub", subcommand: "", notes: undefined, caller: "job" },
      { event: "fleet command", command: "devbox", subcommand: "list", notes: undefined, caller: "job" },
      { event: "fleet command", command: "settings-snapshot", subcommand: "", notes: undefined, caller: "job" },
      { event: "memory recalled", command: undefined, subcommand: undefined, notes: 1, caller: expect.any(String) },
    ]);

    expect((await fleet(["usage", "flush"], home)).code).toBe(0);
    const sent = JSON.stringify(received);
    for (const leak of [token, "customer", "Please read", "Pass full SHAs", "4817"]) expect(sent).not.toContain(leak);
    expect(received.map((request) => [request.path, request.body.api_key, request.body.batch.length])).toEqual([["/batch/", key, 7]]);
    expect(received[0]!.body.batch[0]!.properties).toMatchObject({ distinct_id: expect.stringMatching(/^fleet-/), $process_person_profile: false });
    expect(existsSync(spool(home))).toBe(false);
  });

  test("a flush sends each event once, and a distinct id from the settings names every event", async () => {
    const home = await machine([], { ...destination(), "base.usageDistinctId": "me" });
    await fleet(["settings"], home);
    await fleet(["usage", "flush"], home);
    await fleet(["usage", "flush"], home);
    expect(received.map((request) => request.body.batch.map((event) => [event.event, event.properties.distinct_id]))).toEqual([[["fleet command", "me"]]]);
  });

  test("a machine that cannot send keeps at most 5 MB of events", async () => {
    const home = await machine([], destination());
    writeFileSync(join(home, ".local/state/fleet/usage.sending.jsonl"), "x".repeat(4_999_990));
    await fleet(["settings"], home);
    await fleet(["packs"], home);
    expect(spooled(home).map((line) => line.properties.command)).toEqual(["settings"]);
  });
});

describe("fleet usage flush", () => {
  const to = () => ({ host: `http://127.0.0.1:${server.port}`, projectKey: projectKey(), distinctId: "" });
  const io = (waits: number[]) => ({ send: fetch, wait: async (ms: number) => void waits.push(ms) });

  test("tries again after a failed send, waiting longer each time", async () => {
    const home = await machine([], destination());
    await fleet(["settings"], home);
    answers = [503, 503];
    const waits: number[] = [];
    expect(await flush(home, to(), io(waits))).toBe(1);
    expect(waits).toEqual([1000, 2000]);
    expect(received).toHaveLength(3);
  });

  test("keeps the events when every try fails, and sends them with the next events on the next flush", async () => {
    const home = await machine([], destination());
    await fleet(["settings"], home);
    answers = [500, 500, 500];
    await expect(flush(home, to(), io([]))).rejects.toThrow("answered 500 3 times. The events stay in the spool for the next flush.");
    await fleet(["packs"], home);
    received.length = 0;
    expect(await flush(home, to(), io([]))).toBe(2);
    expect(received[0]!.body.batch.map((event) => event.properties.command).sort()).toEqual(["packs", "settings"]);
  });

  test("refuses a host that would send the project key in the clear", async () => {
    const home = await machine([], { ...destination(), "base.usageHost": "http://analytics.example.test" });
    await fleet(["settings"], home);
    expect((await fleet(["usage", "flush"], home)).code).toBe(1);
    expect(received).toEqual([]);
    expect(spooled(home)).toHaveLength(1);
  });
});
