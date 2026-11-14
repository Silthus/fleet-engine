import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { startT3Stub, type T3Fixture, type T3Stub } from "../../base/lib/t3/testing.ts";
import { runActivity } from "./activity.ts";
import { linkedEnvironment, linkedItem, linkedThread, linkedTools, minutesAgo, shellThread, type LinkedThreadFixture } from "./testing.ts";

const command = join(import.meta.dir, "..", "commands", "activity.ts");
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function stub(fixture: T3Fixture): Promise<T3Stub> {
  const started = await startT3Stub(fixture);
  cleanups.push(() => started.stop());
  return started;
}

const linkedThreads: LinkedThreadFixture[] = [
  linkedThread("mcp:linked-busy", { status: "running", updatedAt: minutesAgo(5), pullRequests: [{ host: "github.com", repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", source: "agent", state: null }] }),
  linkedThread("mcp:linked-done", { status: "completed", updatedAt: minutesAgo(90), branch: "feature/done", items: [
    linkedItem("user_message", "Old ask", { updatedAt: minutesAgo(200) }),
    linkedItem("assistant_message", "Done."),
    linkedItem("user_message", "Ship it", { updatedAt: minutesAgo(80) }),
    linkedItem("user_message", "agent note", { createdBy: "agent", creationSource: "mcp", updatedAt: minutesAgo(80) }),
  ] }),
  linkedThread("mcp:linked-child", { status: "idle", parentThreadId: "mcp:linked-busy", updatedAt: minutesAgo(10), pullRequests: [{ host: "github.com", repository: "acme/app", number: 8, url: "https://github.com/acme/app/pull/8", source: "agent", state: null }] }),
  linkedThread("mcp:linked-settled", { status: "completed", settled: true, updatedAt: minutesAgo(400) }),
];

function fixture(links = [linkedEnvironment]): T3Fixture {
  return {
    shell: {
      projects: [{ id: "project-local", title: "Local project", workspaceRoot: "/work/local" }],
      threads: [
        shellThread("mcp:local-busy", { status: "running", activeRunId: "run-1", latestRunStartedAt: minutesAgo(2), modelSelection: { model: "model-b" } }),
        shellThread("mcp:local-idle", { status: "completed", latestRunCompletedAt: minutesAgo(30), latestUserAuthoredMessageAt: minutesAgo(40) }),
      ],
    },
    archived: { projects: [], threads: [shellThread("mcp:local-archived", { archivedAt: minutesAgo(100), latestRunCompletedAt: minutesAgo(120) })] },
    turnItems: { "mcp:local-idle": [{ item: { type: "user_message", createdBy: "user", text: "Local ask", startedAt: minutesAgo(40) } }] },
    links,
    tools: linkedTools(linkedThreads),
  };
}

async function activity(t3: T3Stub, ...args: string[]) {
  const lines: string[] = [];
  const code = await runActivity(args, { home: t3.home, host: "this-box", print: (line) => lines.push(line) });
  return { code, output: lines.join("\n") };
}

test("fleet activity lists this machine and each linked environment from the local T3 server, with no peers.json", async () => {
  const t3 = await stub(fixture());
  const child = Bun.spawn(["bun", command], { env: { ...Bun.env, HOME: t3.home, FLEET_SETTINGS: "{}" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(existsSync(join(t3.home, ".config", "fleet", "peers.json"))).toBe(false);
  expect(stdout).toBe([
    hostname(),
    `  * running ${minutesAgo(2)} Local project: Thread mcp:local-busy`,
    "    mcp:local-busy model-b /work/local",
    `    completed ${minutesAgo(30)} Local project: Thread mcp:local-idle`,
    "    mcp:local-idle  /work/local",
    `    idle ${minutesAgo(120)} Local project: Thread mcp:local-archived`,
    "    mcp:local-archived  /work/local",
    "devbox-2",
    `  * running ${minutesAgo(5)} Linked project: Thread mcp:linked-busy`,
    "    mcp:linked-busy model-a ",
    `    idle ${minutesAgo(10)} Linked project: Thread mcp:linked-child`,
    "    mcp:linked-child model-a ",
    `    completed ${minutesAgo(90)} Linked project: Thread mcp:linked-done`,
    "    mcp:linked-done model-a ",
    `    completed ${minutesAgo(400)} Linked project: Thread mcp:linked-settled`,
    "    mcp:linked-settled model-a ",
    "",
  ].join("\n"));
});

test("--open lists the open top-level threads of every machine with the PRs their subagent threads link", async () => {
  const t3 = await stub(fixture());
  const { code, output } = await activity(t3, "--open");
  const reports = JSON.parse(output);

  expect(code).toBe(0);
  expect(reports.map((report: { host: string; work: { id: string }[] }) => [report.host, report.work.map((work) => work.id)])).toEqual([
    ["this-box", ["mcp:local-busy", "mcp:local-idle"]],
    ["devbox-2", ["mcp:linked-busy", "mcp:linked-done"]],
  ]);
  expect(reports[1].work[0]).toMatchObject({
    title: "Thread mcp:linked-busy", project: "Linked project", status: "running", waiting: false, updatedAt: minutesAgo(5),
    pullRequests: [{ repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" }, { repository: "acme/app", number: 8, url: "https://github.com/acme/app/pull/8" }],
  });
});

test("--since lists the top-level threads the user wrote in since then, with their messages from then on", async () => {
  const t3 = await stub(fixture());
  const { code, output } = await activity(t3, "--since", minutesAgo(150));
  const reports = JSON.parse(output);

  expect(code).toBe(0);
  expect(reports[0].work.map((work: { id: string; messages: string[] }) => [work.id, work.messages])).toEqual([["mcp:local-idle", ["Local ask"]]]);
  expect(reports[1].work).toEqual([{ id: "mcp:linked-done", title: "Thread mcp:linked-done", project: "Linked project", status: "completed", branch: "feature/done", pullRequests: [], messages: ["Ship it"] }]);
});

test("--since keeps a user message longer than one read whole", async () => {
  const long = "y".repeat(60_000);
  const t3 = await stub({ ...fixture(), tools: linkedTools([
    linkedThread("mcp:linked-long", { status: "completed", updatedAt: minutesAgo(10), items: [linkedItem("user_message", long, { itemId: "long-ask", updatedAt: minutesAgo(10) })] }),
  ]) });
  const reports = JSON.parse((await activity(t3, "--since", minutesAgo(150))).output);

  expect(reports[1].work.map((work: { id: string; messages: string[] }) => [work.id, work.messages.map((message) => message.length)])).toEqual([["mcp:linked-long", [60_000]]]);
  expect(reports[1].work[0].messages[0]).toBe(long);
});

test("a host reads one machine: a linked environment by label or id, or this one by name", async () => {
  const t3 = await stub(fixture());

  const linked = JSON.parse((await activity(t3, "devbox-2", "--thread", "mcp:linked-done")).output);
  expect(linked).toHaveLength(1);
  expect(linked[0].host).toBe("devbox-2");
  expect(linked[0].thread.thread.threadId).toBe("mcp:linked-done");

  const local = JSON.parse((await activity(t3, "--local", "--json", "--limit", "1")).output);
  expect(local.map((report: { host: string; threads: { id: string }[] }) => [report.host, report.threads.map((thread) => thread.id)])).toEqual([["this-box", ["mcp:local-busy", "mcp:local-idle"]]]);

  await expect(activity(t3, "nowhere")).rejects.toThrow("No linked environment nowhere. Linked: devbox-2.");
  const words = JSON.parse((await activity(t3, "env-linked", "--thread", "mcp:linked-done", "--words")).output);
  expect(words).toEqual([{ host: "devbox-2", words: [
    { thread: "mcp:linked-done", id: expect.any(String), text: "Old ask", answered: "", at: minutesAgo(200), source: "typed" },
    { thread: "mcp:linked-done", id: expect.any(String), text: "Ship it", answered: "Done.", at: minutesAgo(80), source: "typed" },
  ] }]);
});

test("a linked environment that cannot answer is named with its reason, and the command exits 1", async () => {
  const t3 = await stub(fixture([{ ...linkedEnvironment, status: "expired", lastError: "link expired" }]));
  const { code, output } = await activity(t3);

  expect(code).toBe(1);
  expect(output).toContain("devbox-2: its link expired. Link it again in T3 Code's Settings → Connections.");
});

test("without a running T3 server, fleet activity says so and exits 1 at once", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-no-t3-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const child = Bun.spawn(["bun", command], { env: { ...Bun.env, HOME: home, FLEET_SETTINGS: "{}" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe(`fleet: T3 is not running on this machine: no server-runtime.json in ${join(home, ".t3", "userdata")}. Start T3 Code, then try again.\n`);
});

test("a thread that awaits a shell command or waits on another thread is busy, and one with a plain background command is not", async () => {
  const t3 = await stub({
    shell: {
      projects: [{ id: "project-local", title: "Local project", workspaceRoot: "/work/local" }],
      threads: [
        shellThread("mcp:awaits-shell", { status: "completed", pendingBackgroundTasks: [{ kind: "command", awaited: true }] }),
        shellThread("mcp:waits-on-thread", { status: "completed", blockedOnThreadWait: true }),
        shellThread("mcp:dev-server", { status: "completed", pendingBackgroundTasks: [{ kind: "command" }] }),
      ],
    },
    archived: { projects: [], threads: [] },
    links: [],
  });
  const { output } = await activity(t3);
  const busy = output.split("\n").filter((line) => line.startsWith("  * ")).map((line) => line.split("Thread ").at(-1));
  expect(busy.sort()).toEqual(["mcp:awaits-shell", "mcp:waits-on-thread"]);
});
