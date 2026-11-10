import { afterEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import { join } from "node:path";
import { startT3Stub, type T3Fixture, type T3Stub } from "../../base/lib/t3/testing.ts";
import { runThread } from "./thread.ts";
import { linkedEnvironment, linkedItem, linkedThread, linkedTools, minutesAgo, shellThread, type LinkedThreadFixture } from "./testing.ts";

const command = join(import.meta.dir, "..", "commands", "thread.ts");
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const linkedThreads: LinkedThreadFixture[] = [
  linkedThread("mcp:linked-busy", { status: "running", updatedAt: minutesAgo(5) }),
  linkedThread("mcp:linked-done", { status: "completed", updatedAt: minutesAgo(90), items: [linkedItem("user_message", "Ship it"), linkedItem("assistant_message", "Shipped.")] }),
  linkedThread("mcp:linked-conductor", { status: "idle", runtimeMode: "full-access" }),
  linkedThread("mcp:everywhere"),
  linkedThread("mcp:remote-only"),
];

function fixture(links = [linkedEnvironment], threads = linkedThreads): T3Fixture {
  return {
    shell: {
      projects: [{ id: "project-local", title: "Local project", workspaceRoot: "/work/local" }],
      threads: [
        shellThread("mcp:local-busy", { status: "running", activeRunId: "run-1", latestRunStartedAt: minutesAgo(2) }),
        shellThread("mcp:local-idle", { status: "completed", latestRunCompletedAt: minutesAgo(30) }),
        shellThread("mcp:everywhere"),
        shellThread("one:twin"),
        shellThread("two:twin"),
      ],
    },
    archived: { projects: [], threads: [shellThread("mcp:local-archived", { archivedAt: minutesAgo(100) })] },
    links,
    tools: linkedTools(threads),
    rpc: (tag) => (tag === "orchestration.dispatchCommand" ? { sequence: 1 } : undefined),
  };
}

async function stub(given = fixture()): Promise<T3Stub> {
  const started = await startT3Stub(given);
  cleanups.push(() => started.stop());
  return started;
}

async function thread(t3: T3Stub, args: string[], stdin = "") {
  const lines: string[] = [];
  const code = await runThread(args, { home: t3.home, host: "this-box", print: (line) => lines.push(line), readStdin: async () => stdin });
  return { code, output: lines.join("\n") };
}

const dispatched = (t3: T3Stub) => t3.rpcCalls.filter((call) => call.tag === "orchestration.dispatchCommand").map((call) => call.payload as Record<string, unknown>);
const sends = (t3: T3Stub) => t3.toolCalls.filter((call) => call.name === "t3_thread_send").map((call) => call.args);

test("fleet thread send reaches a thread on a linked environment, found without --host, through T3's send tool", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["send", "mcp:linked-busy", "Rebase", "on", "main"]);

  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ host: "devbox-2", threadId: "mcp:linked-busy", delivery: "queued" });
  expect(sends(t3)).toEqual([{ environmentId: "env-linked", threadId: "mcp:linked-busy", message: "Rebase on main", mode: "queue", clientRequestId: expect.stringMatching(/^fleet-thread-send:/) }]);
  expect(dispatched(t3)).toEqual([]);
});

test("fleet thread send takes the message from stdin and queues it behind the running turn of a thread on this machine", async () => {
  const t3 = await stub();
  const child = Bun.spawn(["bun", command, "send", "--host", hostname(), "mcp:local-busy"], { env: { ...Bun.env, HOME: t3.home, FLEET_SETTINGS: "{}" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write("It's done'; rm -rf ~ #\n");
  child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ threadId: "mcp:local-busy", delivery: "queued" });
  expect(dispatched(t3)).toEqual([expect.objectContaining({
    type: "message.dispatch", threadId: "mcp:local-busy", text: "It's done'; rm -rf ~ #", attachments: [],
    dispatchMode: { type: "queue_after_active" }, createdBy: "agent", creationSource: "server",
  })]);
  expect(sends(t3)).toEqual([]);
});

test("an idle thread on this machine starts a turn with the message", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["send", "mcp:local-idle", "Go"]);

  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ host: "this-box", threadId: "mcp:local-idle", delivery: "started" });
  expect(dispatched(t3)).toEqual([expect.objectContaining({ text: "Go", dispatchMode: { type: "start_immediately" } })]);
});

test("fleet thread send refuses an archived thread, an empty message, and a thread it cannot place, and sends nothing", async () => {
  const t3 = await stub();

  await expect(thread(t3, ["send", "mcp:local-archived", "Hi"])).rejects.toThrow("Thread mcp:local-archived is archived. Unarchive it before you send it a message.");
  await expect(thread(t3, ["send", "mcp:local-idle"], "  \n")).rejects.toThrow("The message is empty.");
  await expect(thread(t3, ["send", "mcp:everywhere", "Hi"])).rejects.toThrow("Thread mcp:everywhere is on this-box, devbox-2. Choose one with --host.");
  await expect(thread(t3, ["send", "mcp:nowhere", "Hi"])).rejects.toThrow("No machine has thread mcp:nowhere.");
  await expect(thread(t3, ["send", "--host", "nowhere", "mcp:local-idle", "Hi"])).rejects.toThrow("No linked environment nowhere. Linked: devbox-2.");
  expect(dispatched(t3)).toEqual([]);
  expect(sends(t3)).toEqual([]);
});

test("a linked environment that cannot answer is named when no machine has the thread", async () => {
  const t3 = await stub(fixture([{ ...linkedEnvironment, status: "unreachable", lastError: "connection refused" }]));

  await expect(thread(t3, ["send", "mcp:linked-busy", "Hi"])).rejects.toThrow("No machine has thread mcp:linked-busy.\ndevbox-2: did not answer: connection refused");
});

test("T3's refusal of a linked send is shown as T3 words it", async () => {
  const t3 = await stub();

  await expect(thread(t3, ["send", "--host", "devbox-2", "mcp:linked-conductor", "Hi"])).rejects.toThrow("Thread mcp:linked-conductor runs in full-access mode, above this caller's.");
});

test("words after the thread id are the message, even when they look like flags", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["send", "--host", "this-box", "mcp:everywhere", "Explain", "--host", "devbox-2"]);

  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ host: "this-box", threadId: "mcp:everywhere" });
  expect(dispatched(t3)).toEqual([expect.objectContaining({ threadId: "mcp:everywhere", text: "Explain --host devbox-2" })]);
  expect(sends(t3)).toEqual([]);
});

test("a short id finds a linked thread the same way it finds a local one, and an id that fits two threads is refused", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["send", "remote-only", "Hi"]);

  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ host: "devbox-2", threadId: "mcp:remote-only" });
  await expect(thread(t3, ["send", "twin", "Hi"])).rejects.toThrow("On this-box, twin fits one:twin, two:twin. Give the full id.");
  expect(dispatched(t3)).toEqual([]);
});

test("an archived linked thread named by its full id wins over a live thread whose id ends with it", async () => {
  const t3 = await stub(fixture([linkedEnvironment], [...linkedThreads, linkedThread("target", { archived: true }), linkedThread("mcp:target")]));
  const { code, output } = await thread(t3, ["send", "--host", "devbox-2", "target", "Hi"]);

  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ host: "devbox-2", threadId: "target" });
  expect(sends(t3)).toEqual([expect.objectContaining({ threadId: "target" })]);
});

test("a short id that fits two threads on a linked machine is refused, even when this machine has one match", async () => {
  const t3 = await stub(fixture([linkedEnvironment], [...linkedThreads, linkedThread("one:local-idle"), linkedThread("two:local-idle")]));

  await expect(thread(t3, ["read", "local-idle"])).rejects.toThrow("On devbox-2, local-idle fits one:local-idle, two:local-idle. Give the full id.");
  await expect(thread(t3, ["send", "local-idle", "Hi"])).rejects.toThrow("On devbox-2, local-idle fits one:local-idle, two:local-idle. Give the full id.");
  expect(dispatched(t3)).toEqual([]);
});

test("an unqualified send waits for every machine to answer, so a copy on a silent machine is never skipped", async () => {
  const t3 = await stub(fixture([linkedEnvironment, { ...linkedEnvironment, environmentId: "env-down", label: "devbox-3", status: "unreachable", lastError: "connection refused" }]));

  await expect(thread(t3, ["send", "mcp:local-idle", "Hi"])).rejects.toThrow("Thread mcp:local-idle is on this-box, but devbox-3 could not be checked (did not answer: connection refused). Choose the machine with --host.");
  expect(dispatched(t3)).toEqual([]);
  const { code } = await thread(t3, ["send", "--host", "this-box", "mcp:local-idle", "Hi"]);
  expect(code).toBe(0);
});

test("fleet thread read finds a linked thread and prints its messages", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["read", "mcp:linked-done"]);
  const read = JSON.parse(output);

  expect(code).toBe(0);
  expect(read.host).toBe("devbox-2");
  expect(read.thread.thread.threadId).toBe("mcp:linked-done");
  expect(read.thread.items.map((item: { text: string }) => item.text)).toEqual(["Ship it", "Shipped."]);
});

test("fleet thread list lists the threads of this machine and each linked environment", async () => {
  const t3 = await stub();
  const { code, output } = await thread(t3, ["list", "--json"]);
  const reports = JSON.parse(output);

  expect(code).toBe(0);
  expect(reports.map((report: { host: string; threads: { id: string }[] }) => [report.host, report.threads.map((listed) => listed.id)])).toEqual([
    ["this-box", ["mcp:local-busy", "mcp:local-idle", "mcp:everywhere", "mcp:local-archived", "one:twin", "two:twin"]],
    ["devbox-2", ["mcp:linked-busy", "mcp:linked-done", "mcp:everywhere", "mcp:linked-conductor", "mcp:remote-only"]],
  ]);
});

test("fleet thread without an action prints its usage", async () => {
  const t3 = await stub();

  await expect(thread(t3, [])).rejects.toThrow("Usage: fleet thread list");
  await expect(thread(t3, ["read"])).rejects.toThrow("Usage: fleet thread list");
});
