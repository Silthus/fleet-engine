import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRow } from "../../pack/types.ts";
import { t3CliRunner, t3Threads } from "./index.ts";
import { startT3Stub, type T3Fixture, type T3Stub } from "./testing.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const models: ModelRow[] = [
  { role: "implementation", work: "Implementation", provider: "claude", model: "claude-big", effort: "high" },
  { role: "lookup", work: "Lookups", provider: "codex", model: "gpt-small", effort: "medium" },
];

async function t3(fixture: Partial<T3Fixture> = {}): Promise<T3Stub> {
  let launched = 0;
  const stub = await startT3Stub({
    shell: { projects: [], threads: [] },
    environmentId: "env-1",
    rpc(tag) {
      if (tag === "projects.ensureScratch") return { projectId: "scratch-1" };
      if (tag === "orchestration.launchThread") return { threadId: `thread-${++launched}` };
    },
    ...fixture,
  });
  cleanups.push(() => stub.stop());
  return stub;
}

const request = { title: "Slack: the build is red", prompt: "Find out why the build is red.", modelRole: "implementation" };

test("a second start with the same key returns the first thread and its link, and a new key starts a new thread", async () => {
  const stub = await t3();
  const threads = t3Threads(models, { home: stub.home });
  const first = await threads.start({ ...request, key: "slack-message-1" });
  expect(first).toEqual({ id: "thread-1", url: "https://app.t3.codes/threads/env-1/thread-1" });
  expect(await threads.start({ ...request, key: "slack-message-1" })).toEqual(first);
  expect((await threads.start({ ...request, key: "slack-message-2" })).id).toBe("thread-2");
  expect(stub.threads.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
});

test("after T3 starts a thread but its answer is lost, a retry with the same key returns that thread", async () => {
  let lost = false;
  const stub = await t3({ loseAnswer: (tag) => tag === "orchestration.launchThread" && !lost && (lost = true) });
  await expect(t3Threads(models, { home: stub.home }).start({ ...request, key: "slack-message-1" })).rejects.toThrow();
  expect(await t3Threads(models, { home: stub.home }).start({ ...request, key: "slack-message-1" })).toEqual({ id: "thread-1", url: "https://app.t3.codes/threads/env-1/thread-1" });
  expect(stub.threads.map((thread) => thread.id)).toEqual(["thread-1"]);
});

test("the model role starts the thread with that row's provider, model, and effort", async () => {
  const stub = await t3();
  await t3Threads(models, { home: stub.home }).start({ ...request, key: "k", modelRole: "lookup" });
  expect(stub.threads).toEqual([{ id: "thread-1", title: request.title, prompt: request.prompt, modelSelection: { instanceId: "codex", model: "gpt-small", options: [{ id: "reasoningEffort", value: "medium" }] } }]);
});

test("a role the model table lacks fails with a sentence that names it", async () => {
  const stub = await t3();
  await expect(t3Threads(models, { home: stub.home }).start({ ...request, key: "k", modelRole: "review" })).rejects.toThrow("The model table of your AI plan has no review row");
  expect(stub.threads).toEqual([]);
});

test("without T3 on the machine, a start fails with a sentence that says T3 is not running", async () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-no-t3-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  await expect(t3Threads(models, { home }).start({ ...request, key: "k" })).rejects.toThrow(/^T3 is not running on this machine: .* Start T3 Code, then try again\.$/);
});

test("a thread without a known environment has no link", async () => {
  const stub = await t3({ environmentId: undefined });
  expect(await t3Threads(models, { home: stub.home }).start({ ...request, key: "k" })).toEqual({ id: "thread-1" });
});

test("a thread that started counts as started when revoking its T3 session fails", async () => {
  const stub = await t3();
  const runCli = t3CliRunner();
  const threads = t3Threads(models, { home: stub.home, runCli: (server, args) => (args.slice(0, 3).join(" ") === "auth session revoke" ? { status: 1, stdout: "", stderr: "revoke failed" } : runCli(server, args)) });
  expect(await threads.start({ ...request, key: "slack-message-1" })).toEqual({ id: "thread-1", url: "https://app.t3.codes/threads/env-1/thread-1" });
});

function writeReport(home: string, providers: Record<string, string>, checkedAt = new Date().toISOString()) {
  mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
  writeFileSync(join(home, ".local/state/fleet/provider-availability.json"), JSON.stringify({ checkedAt, providers }));
}

test("a start whose model role maps to an exhausted provider is refused with a sentence, and the other provider still starts", async () => {
  const stub = await t3();
  writeReport(stub.home, { claude: "exhausted", codex: "available" });
  const threads = t3Threads(models, { home: stub.home });
  await expect(threads.start({ ...request, key: "k" })).rejects.toThrow(/^Fleet did not start "Slack: the build is red": claude, the provider of the implementation model claude-big, has spent its quota \(fleet providers checked .*\)\. Wait until fleet providers says claude is available, or start it on another model\.$/);
  expect(stub.threads).toEqual([]);
  expect((await threads.start({ ...request, key: "k2", modelRole: "lookup" })).id).toBe("thread-1");
});

test("a report over five minutes old, or one that says unknown, refuses nothing", async () => {
  const stub = await t3();
  writeReport(stub.home, { claude: "exhausted", codex: "exhausted" }, new Date(Date.now() - 6 * 60_000).toISOString());
  expect((await t3Threads(models, { home: stub.home }).start({ ...request, key: "k" })).id).toBe("thread-1");
  writeReport(stub.home, { claude: "unknown", codex: "unknown" });
  expect((await t3Threads(models, { home: stub.home }).start({ ...request, key: "k2" })).id).toBe("thread-2");
});
