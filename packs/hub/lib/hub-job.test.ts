import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, constants, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { spawnText, threadModel, threadScript, underLock, type JobContext } from "./hub-job.ts";

const temp = tempDirs();
const heldFifos: string[] = [];
afterEach(() => {
  for (const fifo of heldFifos.splice(0)) release(fifo);
  temp.cleanup();
});

const row = (provider: string, model: string) => JSON.stringify([{ role: "implementation", work: "Implementation", provider, model, effort: "high" }]);

function stubT3(dir: string, threadExit = 0) {
  writeFileSync(join(dir, "t3"), `#!/bin/sh\necho "$*" >> "${dir}/calls"\nif [ "$1" = thread ]; then\n  for arg; do printf '%s\\n' "$arg"; done > "${dir}/argv"\n  cat > "${dir}/stdin"\n  exit ${threadExit}\nfi\n`);
  chmodSync(join(dir, "t3"), 0o755);
}

test("a thread starts with the T3 provider and the model of its FLEET_MODELS row, passed together, and its text only on standard input", () => {
  const dir = temp.make("thread-");
  stubT3(dir);
  const choice = threadModel("implementation", "fallback-model", { FLEET_MODELS: row("codex", "gpt-model") });
  const run = Bun.spawnSync(["sh", "-c", threadScript(dir, "Slack C1 1.2", choice)], { stdin: Buffer.from("the task"), env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir } });
  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(dir, "argv"), "utf8").split("\n")).toEqual(["thread", "start", "--title", "Slack C1 1.2", "--provider", "codex", "--model", "gpt-model", dir, "-", ""]);
  expect(readFileSync(join(dir, "stdin"), "utf8")).toBe("the task");
  expect(threadModel("implementation", "fallback-model", { FLEET_MODELS: row("claude", "big-model") })).toEqual({ provider: "claudeAgent", model: "big-model" });
  expect(threadModel("implementation", "fallback-model", {})).toEqual({ provider: "claudeAgent", model: "fallback-model" });
});

test("the folder is registered as a project first, and a thread start that creates the thread but exits 1 is never tried again", () => {
  const dir = temp.make("thread-");
  stubT3(dir, 1);
  const run = Bun.spawnSync(["sh", "-c", threadScript(dir, "Slack C1 1.2", { provider: "claudeAgent", model: "big-model" })], { stdin: Buffer.from("the task"), env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir } });
  expect(run.exitCode).toBe(1);
  expect(readFileSync(join(dir, "calls"), "utf8").trim().split("\n")).toEqual([
    `project add ${dir}`,
    `thread start --title Slack C1 1.2 --provider claudeAgent --model big-model ${dir} -`,
  ]);
});

function release(fifo: string) {
  try { closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)); } catch {}
}

function holdingStub(escapeGroup: boolean) {
  const dir = temp.make("hold-");
  const [hold, ready] = [join(dir, "hold"), join(dir, "ready")];
  Bun.spawnSync(["mkfifo", hold, ready]);
  heldFifos.push(hold);
  writeFileSync(join(dir, "job.sh"), `${escapeGroup ? "setsid " : ""}cat "${hold}" &\necho ready > "${ready}"\nwait\n`);
  const readyLine = () => new Response(Bun.spawn(["cat", ready], { stdout: "pipe" }).stdout).text();
  return { script: join(dir, "job.sh"), readyLine };
}

function manualTimer() {
  const timers: Array<{ ms: number; fire: () => void }> = [];
  return { timers, after: (ms: number, fire: () => void) => (timers.push({ ms, fire }), () => {}) };
}

test("a timeout kills the job's whole process group, so a child that holds standard output open cannot keep the job running", async () => {
  const stub = holdingStub(false);
  const clock = manualTimer();
  const result = spawnText(["sh", stub.script], { PATH: "/usr/bin:/bin" }, { timeoutMs: 50, after: clock.after });
  expect((await stub.readyLine()).trim()).toBe("ready");
  clock.timers[0]?.fire();
  expect(await result).toEqual({ code: 124, stdout: "", stderr: "" });
  expect(clock.timers.map((timer) => timer.ms)).toEqual([50, 5000]);
}, 2000);

test("after the kill, a child that left the process group and still holds standard output is waited for only up to the drain limit", async () => {
  const stub = holdingStub(true);
  const clock = manualTimer();
  const result = spawnText(["sh", stub.script], { PATH: "/usr/bin:/bin" }, { timeoutMs: 50, after: clock.after });
  expect((await stub.readyLine()).trim()).toBe("ready");
  clock.timers[0]?.fire();
  clock.timers[1]?.fire();
  expect((await result).code).toBe(124);
}, 2000);

function lockContext(home: string, lines: string[], path = "/usr/bin:/bin"): JobContext {
  return { home, env: { PATH: path }, self: "my-hub", now: () => 0, log: (line) => lines.push(line) };
}

test("a second run while the first holds the flock exits 0 and logs that the job is already running; the lock ends with the job", async () => {
  const home = temp.make("lock-");
  const lines: string[] = [];
  const ran: string[] = [];
  const context = lockContext(home, lines);
  const first = await underLock(context, "job", "The job", async () => {
    ran.push("first");
    expect(await underLock(context, "job", "The job", async () => (ran.push("second"), 0))).toBe(0);
    return 3;
  });
  expect(first).toBe(3);
  expect(ran).toEqual(["first"]);
  expect(lines).toEqual(["The job is already running, so this run ends."]);
  expect(await underLock(context, "job", "The job", async () => (ran.push("third"), 0))).toBe(0);
  expect(ran).toEqual(["first", "third"]);
});

test("the kernel holds the lock for the holder's lifetime: while another process holds it the job does not run, and once that process ends it does", async () => {
  const home = temp.make("lock-");
  const lines: string[] = [];
  const ran: string[] = [];
  Bun.spawnSync(["mkdir", "-p", join(home, ".local/state/fleet")]);
  const holder = Bun.spawn(["flock", join(home, ".local/state/fleet/job.lock"), "-c", "echo held; exec cat"], { stdin: "pipe", stdout: "pipe", env: { PATH: "/usr/bin:/bin" } });
  const reader = holder.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("held");
  expect(await underLock(lockContext(home, lines), "job", "The job", async () => (ran.push("blocked"), 0))).toBe(0);
  holder.stdin.end();
  await holder.exited;
  expect(await underLock(lockContext(home, lines), "job", "The job", async () => (ran.push("after"), 0))).toBe(0);
  expect(ran).toEqual(["after"]);
  expect(lines).toEqual(["The job is already running, so this run ends."]);
});

test("without flock on PATH, a hub job refuses with one line and does not run", async () => {
  const home = temp.make("lock-");
  let ran = false;
  await expect(underLock(lockContext(home, [], temp.make("empty-bin-")), "job", "The job", async () => ((ran = true), 0)))
    .rejects.toThrow(/^Hub jobs need flock from util-linux, and this machine has none on PATH\.$/);
  expect(ran).toBe(false);
});
