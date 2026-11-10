import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startT3Stub, type T3Stub } from "../../src/integrations/t3/testing.ts";
import type { ShellSnapshot } from "../../src/integrations/t3/threads.ts";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { claudeWrapperCommand } from "./lib/bind.ts";

const temp = tempDirs();
const stubs: T3Stub[] = [];
const servers: { stop(force: boolean): Promise<void> | void }[] = [];
afterEach(async () => {
  temp.cleanup();
  await Promise.all(stubs.splice(0).map((stub) => stub.stop()));
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const wrapper = join(import.meta.dir, "bin/claude");
const recorded = join(import.meta.dir, "fixtures/limited-stream.jsonl");
const key = "cd".repeat(32);
const fleetKeyHelper = 'cat "$HOME/.config/fleet/cli-proxy.key"';

function limitingProxy(retryAfter: string | undefined) {
  const asked: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("x-api-key") !== key) return new Response("unauthorized", { status: 401 });
      asked.push(`${url.pathname} ${(await request.json() as { model: string }).model}`);
      return new Response('{"error":{"type":"rate_limit_error"}}', { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, asked };
}

function fakeClaude(dir: string, stream: string, exit = 1) {
  const path = join(dir, "claude");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" > "${dir}/args"\ncat "${stream}"\nexit ${exit}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function runWrapper(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([wrapper, ...args], { env: { PATH: Bun.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { lines: stdout.trim().split("\n"), stderr, code };
}

describe("the Claude reset wrapper", () => {
  test("reports the proxy's reset time to T3 when a stream ends on a limit with none", async () => {
    const dir = temp.make("claude-");
    const proxy = limitingProxy("3600");
    const before = Date.now() / 1000;
    const { lines, code } = await runWrapper(["-p", "go", "--output-format", "stream-json", "--model", "claude-test-1"], {
      HOME: dir, FLEET_CLAUDE_EXECUTABLE: fakeClaude(dir, recorded), ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: key,
    });
    expect(code).toBe(1);
    expect(proxy.asked).toEqual(["/v1/messages/count_tokens claude-test-1"]);
    const frames = lines.map((line) => JSON.parse(line) as { type: string; session_id?: string; rate_limit_info?: { status: string; resetsAt: number } });
    expect(frames.map((frame) => frame.type)).toEqual(["system", "assistant", "rate_limit_event", "result"]);
    const event = frames[2]!;
    expect(event.session_id).toBe("session-1");
    expect(event.rate_limit_info!.status).toBe("rejected");
    expect(event.rate_limit_info!.resetsAt).toBeGreaterThanOrEqual(before + 3600);
    expect(event.rate_limit_info!.resetsAt).toBeLessThanOrEqual(Date.now() / 1000 + 3600);
  });

  test("reads the proxy key from the file the proxy route uses", async () => {
    const dir = temp.make("claude-");
    mkdirSync(join(dir, ".config/fleet"), { recursive: true });
    writeFileSync(join(dir, ".config/fleet/cli-proxy.key"), `${key}\n`);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const proxy = limitingProxy("120");
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxy.url }, apiKeyHelper: fleetKeyHelper }));
    const { lines } = await runWrapper(["--output-format=stream-json"], { HOME: dir, FLEET_CLAUDE_EXECUTABLE: fakeClaude(dir, recorded), FLEET_CLI_PROXY_URL: proxy.url });
    expect(lines.map((line) => (JSON.parse(line) as { type: string }).type)).toContain("rate_limit_event");
  });

  test("sends the Fleet key file only to Fleet's proxy, whatever key helper the settings name", async () => {
    const dir = temp.make("claude-");
    mkdirSync(join(dir, ".config/fleet"), { recursive: true });
    writeFileSync(join(dir, ".config/fleet/cli-proxy.key"), `${key}\n`);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const other = limitingProxy("120");
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: other.url }, apiKeyHelper: fleetKeyHelper }));
    const { lines } = await runWrapper(["--output-format", "stream-json", "--settings", '{"apiKeyHelper":"cat ~/.other-key"}'], { HOME: dir, FLEET_CLAUDE_EXECUTABLE: fakeClaude(dir, recorded) });
    expect(lines).toEqual((await Bun.file(recorded).text()).trim().split("\n"));
    expect(other.asked).toEqual([]);
  });

  test("finds the real claude on PATH even when a PATH entry is the wrapper's own folder", async () => {
    const dir = temp.make("claude-");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    fakeClaude(bin, recorded, 0);
    const { code, lines } = await runWrapper(["-p", "go"], { HOME: dir, PATH: `.:${join(import.meta.dir, "bin")}:${bin}:${Bun.env.PATH ?? ""}` });
    expect(code).toBe(0);
    expect(lines).toEqual((await Bun.file(recorded).text()).trim().split("\n"));
    expect(readFileSync(join(bin, "args"), "utf8")).toBe("-p go\n");
  });

  test("exits as a shell does when Claude dies on a signal", async () => {
    const dir = temp.make("claude-");
    const path = join(dir, "claude");
    writeFileSync(path, "#!/bin/sh\nkill -ABRT $$\n");
    chmodSync(path, 0o755);
    expect((await runWrapper(["-p", "go"], { HOME: dir, FLEET_CLAUDE_EXECUTABLE: path })).code).toBe(134);
  });

  test("passes the stream through untouched when Claude knows the reset, the proxy names none, or the output is not a stream", async () => {
    const dir = temp.make("claude-");
    const native = join(dir, "native.jsonl");
    const resetsAt = Math.floor(Date.now() / 1000) + 600;
    writeFileSync(native, `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAt}},"session_id":"session-1"}\n${await Bun.file(recorded).text()}`);
    const proxy = limitingProxy(undefined);
    const env = { HOME: dir, ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_AUTH_TOKEN: key };
    const knows = await runWrapper(["--output-format", "stream-json"], { ...env, FLEET_CLAUDE_EXECUTABLE: fakeClaude(dir, native) });
    expect(knows.lines).toEqual((await Bun.file(native).text()).trim().split("\n"));
    const silent = await runWrapper(["--output-format", "stream-json"], { ...env, FLEET_CLAUDE_EXECUTABLE: fakeClaude(dir, recorded) });
    expect(silent.lines).toEqual((await Bun.file(recorded).text()).trim().split("\n"));
    const text = await runWrapper(["-p", "go"], { ...env, FLEET_CLAUDE_EXECUTABLE: fakeClaude(dir, recorded, 0) });
    expect([text.code, text.lines]).toEqual([0, (await Bun.file(recorded).text()).trim().split("\n")]);
    expect(proxy.asked).toEqual(["/v1/messages/count_tokens claude-test-1"]);
  });
});

type Instance = { driver: string; enabled?: boolean; config?: Record<string, unknown>; displayName?: string };

async function t3With(providerInstances: Record<string, Instance>) {
  const settings = { providerInstances: structuredClone(providerInstances), theme: "dark" };
  const rpc = (tag: string, payload: unknown) => {
    if (tag === "server.getConfig") return { settings: structuredClone(settings) };
    if (tag !== "server.updateSettings") return undefined;
    const { patch, providerInstanceMutation: mutation } = payload as { patch: object; providerInstanceMutation?: { operation: string; instanceId: string; instance: Instance } };
    if (Object.keys(patch).length || mutation?.operation !== "upsert" || typeof mutation.instance?.driver !== "string") return undefined;
    settings.providerInstances[mutation.instanceId] = mutation.instance;
    return { settings: structuredClone(settings) };
  };
  const stub = await startT3Stub({ shell: { projects: [], threads: [] } as ShellSnapshot, rpc });
  stubs.push(stub);
  const home = temp.make("home-");
  const lines: string[] = [];
  const run = (mode: string) => claudeWrapperCommand([mode], { home, print: (line) => lines.push(line), session: { home: stub.home } });
  return { settings, run, lines, wrapperPath: join(home, ".config/fleet/recovery/claude") };
}

describe("fleet claude-wrapper", () => {
  test("binds T3's default Claude to the wrapper and keeps the instance's other config", async () => {
    const t3 = await t3With({
      claudeAgent: { driver: "claudeAgent", displayName: "Claude", config: { binaryPath: "", customModels: ["claude-test-1"] } },
      codex: { driver: "codex", config: { binaryPath: "codex" } },
    });
    expect(await t3.run("check")).toBe(1);
    expect(await t3.run("bind")).toBe(0);
    expect(t3.settings.providerInstances.claudeAgent).toEqual({ driver: "claudeAgent", displayName: "Claude", config: { binaryPath: t3.wrapperPath, customModels: ["claude-test-1"] } });
    expect(t3.settings.providerInstances.codex).toEqual({ driver: "codex", config: { binaryPath: "codex" } });
    expect(await t3.run("check")).toBe(0);
    expect(await t3.run("bind")).toBe(0);
  });

  test("installs its own copy of the wrapper, so T3 keeps a working Claude when the workflow or the pack is turned off", async () => {
    const t3 = await t3With({ claudeAgent: { driver: "claudeAgent", config: { binaryPath: "claude" } } });
    expect(await t3.run("bind")).toBe(0);
    expect(statSync(t3.wrapperPath).isSymbolicLink()).toBe(false);
    expect(statSync(t3.wrapperPath).mode & 0o111).not.toBe(0);
    const dir = temp.make("claude-");
    const ran = Bun.spawnSync([t3.wrapperPath, "-p", "go"], { env: { PATH: Bun.env.PATH ?? "", HOME: dir, FLEET_CLAUDE_EXECUTABLE: fakeClaude(dir, recorded, 0) } });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toBe(await Bun.file(recorded).text());
    for (const spoil of [() => writeFileSync(join(t3.wrapperPath, "../claude-reset.ts"), "old"), () => chmodSync(t3.wrapperPath, 0o644)]) {
      spoil();
      expect(await t3.run("check")).toBe(1);
      expect(t3.lines).toContain("Fleet's Claude wrapper is missing or out of date. Run fleet apply.");
      expect(await t3.run("bind")).toBe(0);
      expect(await t3.run("check")).toBe(0);
    }
    expect(Bun.spawnSync([t3.wrapperPath, "-p", "go"], { env: { PATH: Bun.env.PATH ?? "", HOME: dir, FLEET_CLAUDE_EXECUTABLE: fakeClaude(dir, recorded, 0) } }).exitCode).toBe(0);
  });

  test("keeps a custom Claude binary and leaves a disabled instance alone", async () => {
    const t3 = await t3With({
      claudeAgent: { driver: "claudeAgent", config: { binaryPath: "/opt/my/claude" } },
      spare: { driver: "claudeAgent", enabled: false },
    });
    expect(await t3.run("bind")).toBe(0);
    expect(t3.settings.providerInstances).toEqual({
      claudeAgent: { driver: "claudeAgent", config: { binaryPath: "/opt/my/claude" } },
      spare: { driver: "claudeAgent", enabled: false },
    });
    expect(t3.lines).toContain("claudeAgent: kept your Claude binary /opt/my/claude.");
    expect(await t3.run("check")).toBe(0);
  });

  test("creates the Claude instance on a fresh T3 that lists none", async () => {
    const t3 = await t3With({});
    expect(await t3.run("bind")).toBe(0);
    expect(t3.settings.providerInstances).toEqual({ claudeAgent: { driver: "claudeAgent", config: { binaryPath: t3.wrapperPath } } });
  });

  test("is part of provider recovery for Claude plans", () => {
    const sources = () => [engine, ...skillSources(temp.make("skills-"), engine)];
    const plan = resolveEngine(sources(), { packs: ["hub", "recovery"], workflows: { "provider-recovery": true } }, devbox);
    expect(plan.steps).toContainEqual(expect.objectContaining({ id: "claude-wrapper", run: ["fleet", "claude-wrapper", "bind"], check: ["fleet", "claude-wrapper", "check"] }));
    const codex = resolveEngine(sources(), { packs: ["hub", "recovery"], workflows: { "provider-recovery": true }, plan: "codex" }, devbox);
    expect(codex.steps.some((step) => step.id === "claude-wrapper")).toBe(false);
  });
});
