import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startT3Stub, type T3Stub } from "../../src/integrations/t3/testing.ts";
import type { ShellSnapshot } from "../../src/integrations/t3/threads.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { recoverCommand } from "./lib/sweep.ts";
import { fakeProxy, limitedThread, modelRows, recoveryHome, t3Inbox } from "./testing.ts";

const temp = tempDirs();
const stubs: T3Stub[] = [];
afterEach(async () => {
  temp.cleanup();
  await Promise.all(stubs.splice(0).map((stub) => stub.stop()));
});

const minute = 60_000;
const at = (time: string) => Date.parse(`2026-11-10T${time}:00Z`);
const outageThread = (id: string, fields = {}) => limitedThread(id, { lastErrorClass: "provider_error", lastError: "api_error_500: Internal server error", ...fields });

function fakeT3(dir: string) {
  const bin = join(dir, "bin");
  const starts = join(dir, "starts");
  mkdirSync(bin, { recursive: true });
  mkdirSync(starts, { recursive: true });
  writeFileSync(join(bin, "t3"), `#!/bin/sh
[ "$1 $2" = "project add" ] && exit 0
[ "$1 $2" = "thread start" ] || exit 1
[ -e "${dir}/down" ] && exit 1
out="${starts}/$(date +%s%N)"
printf '%s\\n' "$@" > "$out.args"
cat > "$out.prompt"
echo thread-alert
`);
  chmodSync(join(bin, "t3"), 0o755);
  return {
    path: `${bin}:${Bun.env.PATH}`,
    down: (down: boolean) => (down ? writeFileSync(join(dir, "down"), "") : rmSync(join(dir, "down"), { force: true })),
    started: () => readdirSync(starts).filter((name) => name.endsWith(".args")).sort().map((name) => ({
      args: readFileSync(join(starts, name), "utf8").trim().split("\n"),
      prompt: readFileSync(join(starts, name.replace(/args$/, "prompt")), "utf8"),
    })),
  };
}

async function machine(threads: Record<string, unknown>[], answers: Parameters<typeof fakeProxy>[0]) {
  const shell = { projects: [], threads } as unknown as ShellSnapshot;
  const inbox = t3Inbox(() => (shell as unknown as { threads: Record<string, unknown>[] }).threads);
  const stub = await startT3Stub({ shell, rpc: inbox.rpc });
  stubs.push(stub);
  const home = recoveryHome(temp.make("home-"));
  const t3 = fakeT3(temp.make("t3-"));
  const lines: string[] = [];
  const settings = JSON.stringify({ "hub.threadFolder": "~/notes" });
  const run = async (now: number, proxy = fakeProxy(answers)) => recoverCommand([], {
    home, env: { FLEET_MODELS: JSON.stringify(modelRows), FLEET_SETTINGS: settings, PATH: t3.path, HOME: home },
    fetch: proxy.fetch, now: () => now, print: (line) => lines.push(line), session: { home: stub.home },
  });
  return { run, lines, inbox, t3, home, setThreads: (next: Record<string, unknown>[]) => void ((shell as unknown as { threads: unknown[] }).threads = next) };
}

test("retries a thread stopped on a provider error with a growing wait, four times, then starts one alert thread", async () => {
  const box = await machine([outageThread("e")], { "claude-test-1": 200 });
  const sent: number[] = [];
  for (const time of ["20:00", "20:05", "20:10", "20:25", "20:30", "21:05", "21:10", "22:00", "23:00"]) {
    expect(await box.run(at(time))).toBe(0);
    sent.push(box.inbox.delivered().length);
  }
  expect(sent).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 4]);
  expect(box.inbox.delivered()).toEqual(Array.from({ length: 4 }, () => ({ threadId: "e", text: "Continue where you left off." })));
  const alerts = box.t3.started();
  expect(alerts.length).toBe(1);
  expect(alerts[0]!.args).toEqual(["thread", "start", "--title", "1 thread keeps failing on provider errors", "--provider", "claudeAgent", "--model", "claude-test-small", join(box.home, "notes"), "-"]);
  expect(alerts[0]!.prompt).toContain("Thread e (e): api_error_500: Internal server error");
  expect(box.lines).toContain("Thread e (e): retried after a provider error, try 4 of 4.");
});

const spendAllTries = ["20:00", "20:10", "20:30", "21:10"];

test("keeps the spent tries of a thread while it is snoozed, so a snooze never buys it a fifth try", async () => {
  const box = await machine([outageThread("e")], { "claude-test-1": 200 });
  for (const time of spendAllTries) await box.run(at(time));
  box.setThreads([outageThread("e", { snoozedUntil: "2026-11-10T22:30:00.000Z" })]);
  await box.run(at("22:00"));
  box.setThreads([outageThread("e")]);
  for (const time of ["23:00", "23:30"]) await box.run(at(time));
  expect(box.inbox.delivered().length).toBe(4);
  expect(box.t3.started().length).toBe(1);
});

test("tries the alert again on the next sweep when it could not start", async () => {
  const box = await machine([outageThread("e")], { "claude-test-1": 200 });
  for (const time of spendAllTries) await box.run(at(time));
  box.t3.down(true);
  expect(await box.run(at("22:00"))).toBe(1);
  expect(box.t3.started()).toEqual([]);
  box.t3.down(false);
  expect(await box.run(at("22:05"))).toBe(0);
  expect(await box.run(at("22:10"))).toBe(0);
  expect(box.t3.started().length).toBe(1);
});

test("spends no try while the provider does not answer", async () => {
  const box = await machine([outageThread("e")], {});
  for (const time of ["20:00", "20:10", "20:30", "21:10", "22:00"]) await box.run(at(time));
  expect(box.inbox.delivered()).toEqual([]);
  expect(box.t3.started()).toEqual([]);
  expect(box.lines).toContain("Thread e (e): waits for claude, which is unknown.");
  await box.run(at("22:10"), fakeProxy({ "claude-test-1": 200 }));
  expect(box.inbox.delivered().length).toBe(1);
});

test("forgets the tries of a thread that recovered, so its next outage gets four again", async () => {
  const box = await machine([outageThread("e")], { "claude-test-1": 200 });
  for (const time of ["20:00", "20:10", "20:30"]) await box.run(at(time));
  box.setThreads([outageThread("e", { status: "completed", lastErrorClass: null, lastError: null })]);
  await box.run(at("20:40"));
  box.setThreads([outageThread("e", { latestRunId: "run-e2", latestRunCompletedAt: "2026-11-10T21:00:00.000Z" })]);
  for (const time of ["21:05", "21:15", "21:35", "22:15", "23:00"]) await box.run(at(time));
  expect(box.inbox.delivered().length).toBe(7);
  expect(box.t3.started().length).toBe(1);
});

test("leaves spent quota to the limit sweep, and held threads and plain failures alone", async () => {
  const box = await machine([
    outageThread("quota", { lastError: "503 All credentials for model claude-test-1 are cooling down" }),
    outageThread("settled", { settledAt: "2026-11-10T19:30:00.000Z" }),
    outageThread("tool", { lastError: "The tool call failed" }),
  ], { "claude-test-1": 200 });
  await box.run(at("20:00"));
  expect(box.inbox.delivered()).toEqual([{ threadId: "quota", text: "Continue where you left off." }]);
});

test("counts a retry that ran and failed again as a spent try", async () => {
  const box = await machine([outageThread("e")], { "claude-test-1": 200 });
  await box.run(at("20:00"));
  box.setThreads([outageThread("e", { status: "running", activeRunId: "run-e2" })]);
  await box.run(at("20:05"));
  box.setThreads([outageThread("e", { latestRunId: "run-e2", latestRunCompletedAt: "2026-11-10T20:06:00.000Z" })]);
  await box.run(at("20:30"));
  expect(box.lines).toContain("Thread e (e): retried after a provider error, try 2 of 4.");
});

test("keeps the tries in a private state file", async () => {
  const box = await machine([outageThread("e")], { "claude-test-1": 200 });
  await box.run(at("20:00"));
  const path = join(box.home, ".local/state/fleet/outage-resume.json");
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("one failed send does not stop the others, and the sweep says so", async () => {
  const inbox = t3Inbox();
  const refuseFirst = (tag: string, payload: unknown) => ((payload as { threadId?: string }).threadId === "a" ? undefined : inbox.rpc(tag, payload));
  const stub = await startT3Stub({ shell: { projects: [], threads: [outageThread("a"), outageThread("b")] } as unknown as ShellSnapshot, rpc: refuseFirst });
  stubs.push(stub);
  const home = recoveryHome(temp.make("home-"));
  const lines: string[] = [];
  const code = await recoverCommand([], {
    home, env: { FLEET_MODELS: JSON.stringify(modelRows), FLEET_SETTINGS: "{}" }, fetch: fakeProxy({ "claude-test-1": 200 }).fetch,
    now: () => at("20:00") + minute, print: (line) => lines.push(line), session: { home: stub.home },
  });
  expect(code).toBe(1);
  expect(inbox.delivered().map((message) => message.threadId)).toEqual(["b"]);
  expect(lines.some((line) => line.startsWith("Thread a (a): could not send a continue message"))).toBe(true);
});
