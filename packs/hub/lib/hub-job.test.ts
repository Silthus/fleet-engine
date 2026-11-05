import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { threadModel, threadScript, underLock, type JobContext } from "./hub-job.ts";
import { writeHome } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const row = (provider: string, model: string) => JSON.stringify([{ role: "implementation", work: "Implementation", provider, model, effort: "high" }]);

test("a thread starts with the T3 provider and the model of its FLEET_MODELS row, passed together, and its text only on standard input", () => {
  const dir = temp.make("thread-");
  writeFileSync(join(dir, "t3"), `#!/bin/sh\nfor arg; do printf '%s\\n' "$arg"; done > "${dir}/argv"\ncat > "${dir}/stdin"\n`);
  chmodSync(join(dir, "t3"), 0o755);
  const choice = threadModel("implementation", "fallback-model", { FLEET_MODELS: row("codex", "gpt-model") });
  const run = Bun.spawnSync(["sh", "-c", threadScript(dir, "Slack C1 1.2", choice)], { stdin: Buffer.from("the task"), env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir } });
  expect(run.exitCode).toBe(0);
  expect(readFileSync(join(dir, "argv"), "utf8").split("\n")).toEqual(["thread", "start", "--title", "Slack C1 1.2", "--provider", "codex", "--model", "gpt-model", dir, "-", ""]);
  expect(readFileSync(join(dir, "stdin"), "utf8")).toBe("the task");
  expect(threadModel("implementation", "fallback-model", { FLEET_MODELS: row("claude", "big-model") })).toEqual({ provider: "claudeAgent", model: "big-model" });
  expect(threadModel("implementation", "fallback-model", {})).toEqual({ provider: "claudeAgent", model: "fallback-model" });
});

function contender(home: string, pid: number, fields: Partial<JobContext> = {}): JobContext {
  return { home, env: {}, self: "my-hub", now: () => 0, log: () => {}, pid, alive: (holder) => holder !== 1, ...fields };
}

test("two contenders that both find a stale lock take it over one at a time, so exactly one job runs", async () => {
  const home = temp.make("lock-");
  writeHome(home, { ".local/state/fleet/job.lock/owner": JSON.stringify({ pid: 1, token: "dead-run" }) });
  const ran: string[] = [];
  const job = (name: string) => async () => (ran.push(name), 0);
  let second: Promise<number> | undefined;
  const first = underLock(contender(home, 101, { beforeTakeover: () => { second = underLock(contender(home, 102), "job", "job", job("second")); } }), "job", "job", job("first"));
  await Promise.all([first, second]);
  expect(ran).toEqual(["second"]);
  expect(existsSync(join(home, ".local/state/fleet/job.lock"))).toBe(false);
});

test("a holder whose lock was taken over leaves the new holder's lock in place when it ends", async () => {
  const home = temp.make("lock-");
  const lock = join(home, ".local/state/fleet/job.lock");
  let ownerSeen = "";
  await underLock(contender(home, 101), "job", "job", async () => {
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid: 102, token: "newer-run" }));
    ownerSeen = readFileSync(join(lock, "owner"), "utf8");
    return 0;
  });
  expect(readFileSync(join(lock, "owner"), "utf8")).toBe(ownerSeen);
});
