import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { jobsAdapter } from "../../src/adapters/jobs/adapter.ts";
import { main, type CliOptions } from "../../src/cli.ts";
import { startT3Stub } from "../../src/integrations/t3/testing.ts";
import { filesAdapter } from "../../src/reconciler/apply.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { startSlackStub } from "./testing.ts";

const temp = tempDirs();
const stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  temp.cleanup();
});

const repoRoot = join(import.meta.dir, "../..");
const ownerId = "U0OWNER";
const firstApp = ["xapp-", "slice-first"].join("");
const secondApp = ["xapp-", "slice-second"].join("");
const userToken = ["xoxp-", "slice-user"].join("");

function slackAt(base: string) {
  const real = globalThis.fetch;
  globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return real(url.startsWith("https://slack.com/api/") ? `${base}/${url.slice("https://slack.com/api/".length)}` : input, init);
  }, real);
  stops.push(() => (globalThis.fetch = real));
}

function typed(...lines: string[]) {
  const real = { stdin: Object.getOwnPropertyDescriptor(process, "stdin")!, stdout: Object.getOwnPropertyDescriptor(process, "stdout")! };
  const keyboard = new PassThrough();
  keyboard.end(lines.map((line) => `${line}\n`).join(""));
  Object.defineProperty(process, "stdin", { value: keyboard, configurable: true });
  Object.defineProperty(process, "stdout", { value: new PassThrough().resume(), configurable: true });
  return () => (Object.defineProperty(process, "stdin", real.stdin), Object.defineProperty(process, "stdout", real.stdout));
}

async function hub() {
  const liveApps = new Set([firstApp]);
  const slack = startSlackStub([{ user: ownerId, ts: "100.1", text: "the build is red :t3code:" }], ownerId, liveApps);
  stops.push(slack.stop);
  slackAt(slack.base);
  let launched = 0;
  let answerLost = false;
  const t3 = await startT3Stub({
    shell: { projects: [], threads: [] },
    environmentId: "env-hub",
    rpc: (tag) => (tag === "projects.ensureScratch" ? { projectId: "scratch" } : tag === "orchestration.launchThread" ? { threadId: `thread-${++launched}` } : undefined),
    loseAnswer: (tag) => tag === "orchestration.launchThread" && !answerLost && (answerLost = true),
  });
  stops.push(() => t3.stop());
  const home = temp.make("home-");
  mkdirSync(join(home, ".t3/userdata"), { recursive: true });
  cpSync(join(t3.home, ".t3/userdata/server-runtime.json"), join(home, ".t3/userdata/server-runtime.json"));
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Nora Example\n");
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["slack"], plan: "claude", settings: { "slack.userId": ownerId }, workflows: { "slack-thread": true } }));
  const minutes: Array<() => void> = [];
  const engineFleet = join(repoRoot, "fleet");
  let lines: string[] = [];
  const options: CliOptions = {
    home,
    engineRoot: repoRoot,
    platform: "linux",
    env: {},
    print: (line) => lines.push(line),
    run: async (command) => (command[0] === "/bin/sh" && command[1] === engineFleet ? main(command.slice(2), { ...options, print: () => {} }) : 0),
    adapters: () => [filesAdapter, jobsAdapter({ run: async () => ({ code: 0, stdout: "" }), engineRoot: repoRoot })],
    clock: { now: () => Date.parse("2026-11-10T12:00:00Z"), sleep: (ms) => (ms === 60_000 ? new Promise<void>((resolve) => minutes.push(resolve)) : Promise.resolve()) },
  };
  const fleet = async (...args: string[]) => {
    lines = [];
    return { code: await main(args, options), lines };
  };
  const setup = async (appToken: string) => {
    const restore = typed(appToken, userToken);
    try {
      return await fleet("slack-trigger", "setup");
    } finally {
      restore();
    }
  };
  const minute = () => minutes.splice(0).forEach((resolve) => resolve());
  const unit = join(home, ".config/systemd/user/fleet-slack-trigger.service");
  return { home, profile, slack, liveApps, t3, fleet, setup, minute, unit };
}

test("setup installs the trigger, an owner's message starts one thread, and after a lost answer the restarted trigger posts its link once", async () => {
  const { home, profile, slack, liveApps, t3, fleet, setup, minute, unit } = await hub();
  const todo = "Make your own Slack app for Start a thread from Slack, then paste its two tokens. Fleet keeps them where only you can read them. Run: fleet slack-trigger setup";
  const saved = "Saved both tokens where only you can read them. A running Slack trigger starts again with them within a minute.";
  const replies = () => slack.method("chat.postEphemeral").map((call) => call.args.text);

  const before = await fleet("apply", "--profile", profile);
  expect(before.lines.join("\n")).toContain(todo);
  expect(existsSync(unit)).toBe(false);
  expect(await setup(firstApp)).toEqual({ code: 0, lines: expect.arrayContaining([saved, expect.stringContaining("T3Code%20-%20Nora%20Example")]) });
  expect(existsSync(unit)).toBe(true);
  expect(readFileSync(join(home, ".local/state/fleet/jobs/slack-trigger.sh"), "utf8")).toContain("'run' 'slack/slack-trigger'");
  await fleet("apply");
  expect(existsSync(unit)).toBe(true);

  const serving = fleet("run", "slack/slack-trigger");
  await slack.connected();
  slack.send({ type: "message", user: ownerId, channel: "C1", ts: "100.1", text: "the build is red :t3code:" });
  await slack.until(() => replies().length === 1);
  expect(replies()).toEqual(["Could not start a T3 thread. Fleet retries every minute for a day."]);
  expect(t3.threads.map((thread) => thread.title)).toEqual(["Slack: the build is red"]);

  liveApps.add(secondApp);
  expect(await setup(secondApp)).toEqual({ code: 0, lines: expect.arrayContaining([saved]) });
  liveApps.delete(firstApp);
  minute();
  expect((await serving).code).toBe(0);
  const restarted = fleet("run", "slack/slack-trigger");
  await slack.connected(2);
  minute();
  await slack.until(() => replies().length === 2);
  expect(replies()[1]).toBe("Started <https://app.t3.codes/threads/env-hub/thread-1|Slack: the build is red> on this machine.");
  expect(t3.threads.map((thread) => thread.id)).toEqual(["thread-1"]);

  rmSync(join(home, ".config/fleet/secrets/slack/app"));
  minute();
  expect((await restarted).code).toBe(0);
  expect((await fleet("apply")).lines.join("\n")).toContain(todo);
  expect(existsSync(unit)).toBe(false);
});

test("fleet slack-trigger names the Slack pack when the pack is off", async () => {
  const { profile, fleet } = await hub();
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: [], plan: "claude", settings: {}, workflows: {} }));
  await fleet("apply", "--profile", profile);
  expect(await fleet("slack-trigger", "check")).toEqual({ code: 2, lines: ["fleet slack-trigger comes from the Slack pack, which is off. Turn it on with fleet packs."] });
});
