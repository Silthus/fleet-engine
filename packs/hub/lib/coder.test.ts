import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { withBoxLock } from "./box-lock.ts";
import { captureWith, Coder, grant, reap, type Box, type Capture, type Timer } from "./coder.ts";
import { appeared } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const ok = { code: 0, stdout: "", stderr: "" };
const settings = { coderUrl: "https://coder.example.com", template: "linux-box" };

function homeWith(files: Record<string, string>) {
  const home = temp.make("fleet-coder-");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), content);
  }
  return home;
}

function recording() {
  const calls: string[][] = [];
  const capture: Capture = async (argv) => {
    calls.push(argv);
    return ok;
  };
  return { calls, capture };
}

test("the Coder session comes from the environment first, then Fleet's session files, then the Coder CLI's", () => {
  const both = { ".config/fleet/coder-session": "fleet-token\n", ".config/fleet/coder-url": "https://fleet.example.com\n", ".config/coderv2/session": "cli-token\n", ".config/coderv2/url": "https://cli.example.com\n" };
  const fromEnv = new Coder({ ...settings, home: homeWith(both), env: { CODER_SESSION_TOKEN: "env-token", CODER_URL: "https://env.example.com" } });
  expect([fromEnv.env.CODER_SESSION_TOKEN, fromEnv.env.CODER_URL]).toEqual(["env-token", "https://env.example.com"]);
  const fromFleet = new Coder({ ...settings, home: homeWith(both), env: {} });
  expect([fromFleet.env.CODER_SESSION_TOKEN, fromFleet.env.CODER_URL]).toEqual(["fleet-token", "https://fleet.example.com"]);
  const fromCli = new Coder({ ...settings, home: homeWith({ ".config/coderv2/session": "cli-token\n", ".config/coderv2/url": "https://cli.example.com\n" }), env: {} });
  expect([fromCli.env.CODER_SESSION_TOKEN, fromCli.env.CODER_URL]).toEqual(["cli-token", "https://cli.example.com"]);
});

test("without a Coder URL in the environment or a session file, the hub.coderUrl setting is the address", () => {
  const coder = new Coder({ ...settings, home: homeWith({}), env: { CODER_SESSION_TOKEN: "env-token" } });
  expect(coder.env.CODER_URL).toBe("https://coder.example.com");
});

test("without a coder CLI on PATH, it downloads one from the Coder address only when a command needs it, and installs it only once complete", async () => {
  const home = homeWith({});
  const { calls, capture: record } = recording();
  const capture: Capture = async (argv, options) => {
    if (argv[0] === "curl") writeFileSync(argv[3]!, "coder binary");
    return record(argv, options);
  };
  const coder = new Coder({ ...settings, home, env: { PATH: join(home, "empty") }, capture });
  expect(calls).toEqual([]);
  await coder.ssh("box-lane", "true");
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  expect(calls[0]).toEqual(["curl", "-fsSL", "-o", expect.stringMatching(/\/\.local\/bin\/\.coder\.[0-9a-f-]{36}$/), `https://coder.example.com/bin/coder-linux-${arch}`]);
  expect(calls[1]).toEqual([join(home, ".local/bin/coder"), "ssh", "--disable-autostart", "--wait=no", "box-lane", "--", "true"]);
  expect(readFileSync(join(home, ".local/bin/coder"), "utf8")).toBe("coder binary");
});

test("a new box starts from the hub.boxTemplate template with the spawning devbox's parameters and the configured disk", async () => {
  const requests: Array<{ path: string; body?: unknown }> = [];
  const answers: Record<string, unknown> = {
    "/api/v2/templates": [{ id: "tpl-other", name: "other", active_version_id: "v-other" }, { id: "tpl-1", name: "linux-box", active_version_id: "v-1" }],
    "/api/v2/templateversions/v-1/rich-parameters": [{ name: "region" }, { name: "disk_size" }],
    "/api/v2/users/me/workspace/devbox-1": { id: "ws-1", latest_build: { id: "build-1" } },
    "/api/v2/workspacebuilds/build-1/parameters": [{ name: "region", value: "eu" }, { name: "dropped", value: "x" }, { name: "disk_size", value: "50" }],
    "/api/v2/users/me/workspaces": { id: "ws-new" },
  };
  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = url.replace("https://coder.example.com", "");
    requests.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return Response.json(answers[path]);
  }) as unknown as typeof fetch;
  const coder = new Coder({ ...settings, home: homeWith({}), env: { CODER_SESSION_TOKEN: "t" }, fetch: fetcher });
  expect(await coder.create("box-lane", "devbox-1", 120)).toBe("ws-new");
  expect(requests.at(-1)).toEqual({
    path: "/api/v2/users/me/workspaces",
    body: { name: "box-lane", template_id: "tpl-1", rich_parameter_values: [{ name: "region", value: "eu" }, { name: "disk_size", value: "120" }], ttl_ms: 2 * 3_600_000 },
  });
});

test("the reaper deletes only boxes that stopped, failed, or were cancelled and went unused for the given days, and rechecks each before it deletes", async () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const box = (name: string, status: string, lastUsedAt: string): Box => ({ name, id: `ws-${name}`, template: "linux-box", status, lastUsedAt });
  const listed = [box("box-old", "stopped", daysAgo(4)), box("box-busy", "running", daysAgo(4)), box("box-recent", "stopped", daysAgo(1)), box("box-woke", "stopped", daysAgo(4)), box("box-failed", "failed", daysAgo(4)), box("box-canceled", "canceled", daysAgo(4))];
  const current = listed.map((entry) => (entry.name === "box-woke" ? { ...entry, status: "starting" } : entry));
  const removed: string[] = [];
  let reads = 0;
  const coder = { boxes: async () => (reads++ === 0 ? listed : current) };
  const remove = async (name: string) => {
    removed.push(name);
    return 0;
  };
  const print = () => {};
  await reap(coder, { days: 3, dryRun: true, now, print }, remove);
  expect(removed).toEqual([]);
  reads = 0;
  await reap(coder, { days: 3, dryRun: false, now, print }, remove);
  expect(removed).toEqual(["box-old", "box-failed", "box-canceled"]);
});

test("a grant mints a dated token, writes the URL and token on the devbox over stdin, and only then removes the older tokens", async () => {
  const now = Date.parse("2026-11-01T12:34:00Z");
  const tokens: string[][] = [];
  const coder = {
    env: { CODER_URL: "https://coder.example.com" },
    token: async (args: string[]) => {
      tokens.push(args);
      return args[0] === "list" ? JSON.stringify([{ id: "k1", token_name: "fleet-devbox-1-202610010000-abcd", expires_at: "2026-11-02T00:00:00Z" }, { id: "k2", token_name: "someone-else", expires_at: "2026-12-01T00:00:00Z" }]) : "new-secret\n";
    },
  };
  const written: Array<{ command: string; stdin?: string }> = [];
  const onDevbox = async (_target: string, command: string, stdin?: string) => {
    written.push({ command, stdin });
    return ok;
  };
  expect(await grant(coder, "devbox-1", { ifExpiring: true, now, onDevbox, print: () => {} })).toBe(0);
  expect(tokens[1]?.slice(0, 3)).toEqual(["create", "--name", expect.stringMatching(/^fleet-devbox-1-202611011234-[0-9a-f]{4}$/)]);
  expect(written.map((call) => call.stdin)).toEqual([undefined, "https://coder.example.com\n", "new-secret\n"]);
  expect(written.map((call) => call.command).join("\n")).not.toContain("new-secret");
  expect(tokens.at(-1)).toEqual(["remove", "fleet-devbox-1-202610010000-abcd"]);
});

test("a grant with --if-expiring keeps a token that lasts more than a week", async () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  const coder = { env: {}, token: async () => JSON.stringify([{ id: "k1", token_name: "fleet-devbox-1-202610010000-abcd", expires_at: "2026-11-20T00:00:00Z" }]) };
  const onDevbox = async () => ({ ...ok, stdout: "k1\n" });
  const lines: string[] = [];
  expect(await grant(coder, "devbox-1", { ifExpiring: true, now, onDevbox, print: (line) => lines.push(line) })).toBe(0);
  expect(lines).toEqual(["fleet-devbox-1-202610010000-abcd: still valid until 2026-11-20T00:00:00Z"]);
});

test("the reaper goes on after a failed delete and fails at the end, so the nightly job does not report success", async () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  const old = new Date(now - 4 * 86_400_000).toISOString();
  const listed: Box[] = ["box-a", "box-b", "box-c"].map((name) => ({ name, id: `ws-${name}`, template: "linux-box", status: "stopped", lastUsedAt: old }));
  const tried: string[] = [];
  const remove = async (name: string) => {
    tried.push(name);
    if (name === "box-b") throw new Error("coder delete failed");
    return name === "box-a" ? 1 : 0;
  };
  const lines: string[] = [];
  expect(await reap({ boxes: async () => listed }, { days: 3, dryRun: false, now, print: (line) => lines.push(line) }, remove)).toBe(1);
  expect(tried).toEqual(["box-a", "box-b", "box-c"]);
  expect(lines).toContain("box-b: coder delete failed");
  expect(await reap({ boxes: async () => listed }, { days: 3, dryRun: false, now, print: () => {} }, async () => 0)).toBe(0);
});

function sandboxBin(scripts: Record<string, string>) {
  const bin = temp.make("fleet-bin-");
  for (const [name, script] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

test("the readiness calls pass their time limit down to the coder process", async () => {
  const limits: Array<number | undefined> = [];
  const capture: Capture = async (argv, options) => {
    limits.push(options?.timeoutMs);
    return { ...ok, stdout: argv.includes("list") ? "[]" : "" };
  };
  const bin = sandboxBin({ coder: "exit 0" });
  const coder = new Coder({ ...settings, home: homeWith({}), env: { PATH: bin, CODER_SESSION_TOKEN: "t" }, capture });
  await coder.sshAfterStartup("box-lane", "true", 4000);
  await coder.ssh("box-lane", "test -f x", undefined, 3000);
  await coder.boxes(2000);
  expect(limits).toHaveLength(3);
  for (const [index, limit] of [4000, 3000, 2000].entries()) {
    expect(limits[index]).toBeLessThanOrEqual(limit);
    expect(limits[index]).toBeGreaterThan(limit - 500);
  }
});

test("downloading the coder CLI never writes through a file planted at a temporary name", async () => {
  const home = homeWith({ victim: "keep\n" });
  const target = join(home, ".local/bin/coder");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(join(home, "victim"), `${target}.${process.pid}.partial`);
  const capture: Capture = async (argv) => {
    if (argv[0] === "curl") writeFileSync(argv[3]!, "coder binary");
    return ok;
  };
  const coder = new Coder({ ...settings, home, env: { PATH: join(home, "empty") }, capture });
  await coder.ssh("box-lane", "true");
  expect(readFileSync(join(home, "victim"), "utf8")).toBe("keep\n");
  expect(lstatSync(target).isSymbolicLink()).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("coder binary");
});

function handTimer() {
  const pending: Array<{ ms: number; fire(): void }> = [];
  const timer: Timer = (ms, fire) => {
    const entry = { ms, fire };
    pending.push(entry);
    return () => {
      if (pending.includes(entry)) pending.splice(pending.indexOf(entry), 1);
    };
  };
  return { timer, pending, fire: () => pending.splice(0).forEach((entry) => entry.fire()) };
}

const announce = (file: string, what = "$$") => `echo ${what} > ${file}.tmp && /bin/mv ${file}.tmp ${file}`;
const hangs = "exec /bin/sleep 30";

test("a command with a time limit is killed when its timer fires, and reports the timeout", async () => {
  const ready = join(temp.make("fleet-ready-"), "ready");
  const bin = sandboxBin({ hang: `${announce(ready)}\n${hangs}` });
  const clock = handTimer();
  const result = captureWith(clock.timer)([join(bin, "hang")], { timeoutMs: 20 });
  await appeared(ready);
  expect(clock.pending.map((entry) => entry.ms)).toEqual([20]);
  clock.fire();
  expect(await result).toEqual({ code: 124, stdout: "", stderr: "timed out after 20 ms" });
});

test("a command that ends in time cancels its timer and keeps its output", async () => {
  const clock = handTimer();
  const bin = sandboxBin({ say: "echo said; echo warned >&2; exit 3" });
  expect(await captureWith(clock.timer)([join(bin, "say")], { timeoutMs: 1000 })).toEqual({ code: 3, stdout: "said\n", stderr: "warned\n" });
  expect(clock.pending).toEqual([]);
});

test("downloading the coder CLI counts against the call's time limit, so a hanging download cannot outlast a readiness wait", async () => {
  const ready = join(temp.make("fleet-ready-"), "ready");
  const bin = sandboxBin({ curl: `${announce(ready)}\n${hangs}` });
  const home = homeWith({});
  const clock = handTimer();
  const coder = new Coder({ ...settings, home, env: { PATH: bin, CODER_SESSION_TOKEN: "t" }, capture: captureWith(clock.timer) });
  const result = coder.sshAfterStartup("box-lane", "true", 50);
  await appeared(ready);
  expect(clock.pending[0]?.ms).toBeLessThanOrEqual(50);
  clock.fire();
  expect((await result).code).toBe(124);
  expect(readdirSync(join(home, ".local/bin"))).toEqual([]);
});

for (const locked of [false, true]) {
  test(`a timeout kills the whole process group, including a child the shell started without exec${locked ? ", also under a box lock" : ""}`, async () => {
    const held = join(temp.make("fleet-fifo-"), "held");
    expect(Bun.spawnSync(["mkfifo", held]).exitCode).toBe(0);
    const bin = sandboxBin({ spawner: `sh -c 'echo up; exec tail -f /dev/null' > ${held} 2>/dev/null &\nwait` });
    const reader = Bun.spawn(["cat", held], { stdout: "pipe" });
    const clock = handTimer();
    const run = () => captureWith(clock.timer)([join(bin, "spawner")], { timeoutMs: 50 });
    const result = locked ? withBoxLock(temp.make("fleet-lock-"), "box-a", { waitMs: 0 }, run) : run();
    const lines = reader.stdout.getReader();
    expect(new TextDecoder().decode((await lines.read()).value)).toBe("up\n");
    clock.fire();
    expect((await result).code).toBe(124);
    expect(await lines.read()).toEqual({ done: true, value: undefined });
    expect(await reader.exited).toBe(0);
  });
}

test("starting a box gives every Coder API request of the start one time limit", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    const path = url.replace("https://coder.example.com", "");
    const answers: Record<string, unknown> = { "/api/v2/templates": [{ id: "tpl-1", name: "linux-box", active_version_id: "v-1" }], "/api/v2/templateversions/v-1/rich-parameters": [] };
    return Response.json(answers[path] ?? { id: "ws-1" });
  }) as unknown as typeof fetch;
  const coder = new Coder({ ...settings, home: homeWith({}), env: { CODER_SESSION_TOKEN: "t" }, fetch: fetcher });
  await coder.start("ws-1", 60_000, { update: true });
  expect(signals).toHaveLength(3);
  expect(new Set(signals).size).toBe(1);
  expect(signals[0]).toBeInstanceOf(AbortSignal);
});

test("stop, delete, start and extend address the workspace by the id the pool recorded, through the Coder API, each with a time limit", async () => {
  const requests: Array<{ method: string; path: string; body?: unknown; limited: boolean }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? "GET", path: url.replace("https://coder.example.com", ""), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), limited: init?.signal instanceof AbortSignal });
    return Response.json({});
  }) as unknown as typeof fetch;
  const { calls, capture } = recording();
  const coder = new Coder({ ...settings, home: homeWith({}), env: { CODER_SESSION_TOKEN: "t" }, fetch: fetcher, capture });
  await coder.stop("ws-1");
  await coder.remove("ws-2", 1000);
  await coder.start("ws-3", 1000);
  await coder.extend("ws-4", "2026-11-01T02:00:00.000Z");
  expect(requests).toEqual([
    { method: "POST", path: "/api/v2/workspaces/ws-1/builds", body: { transition: "stop" }, limited: true },
    { method: "POST", path: "/api/v2/workspaces/ws-2/builds", body: { transition: "delete" }, limited: true },
    { method: "POST", path: "/api/v2/workspaces/ws-3/builds", body: { transition: "start" }, limited: true },
    { method: "PUT", path: "/api/v2/workspaces/ws-4/extend", body: { deadline: "2026-11-01T02:00:00.000Z" }, limited: true },
  ]);
  expect(calls).toEqual([]);
});

test("creating a box has a time limit on every Coder API request", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const answers: Record<string, unknown> = {
    "/api/v2/templates": [{ id: "tpl-1", name: "linux-box", active_version_id: "v-1" }],
    "/api/v2/templateversions/v-1/rich-parameters": [],
    "/api/v2/users/me/workspace/devbox-1": { id: "ws-1", latest_build: { id: "build-1" } },
    "/api/v2/workspacebuilds/build-1/parameters": [],
    "/api/v2/users/me/workspaces": { id: "ws-new" },
  };
  const fetcher = (async (url: string, init?: RequestInit) => (signals.push(init?.signal ?? undefined), Response.json(answers[url.replace("https://coder.example.com", "")]))) as unknown as typeof fetch;
  const coder = new Coder({ ...settings, home: homeWith({}), env: { CODER_SESSION_TOKEN: "t" }, fetch: fetcher });
  expect(await coder.create("box-lane", "devbox-1", 120)).toBe("ws-new");
  expect(signals).toHaveLength(5);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
});

test("a call that hands its output through to the caller still has a time limit and kills its process group", async () => {
  const ready = join(temp.make("fleet-ready-"), "ready");
  const bin = sandboxBin({ hang: `${announce(ready)}\n${hangs}` });
  const clock = handTimer();
  const result = captureWith(clock.timer)([join(bin, "hang")], { timeoutMs: 30, inherit: true });
  await appeared(ready);
  expect(clock.pending.map((entry) => entry.ms)).toEqual([30]);
  clock.fire();
  expect(await result).toEqual({ code: 124, stdout: "", stderr: "timed out after 30 ms" });
});
