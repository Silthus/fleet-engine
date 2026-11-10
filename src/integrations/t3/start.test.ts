import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRow } from "../../pack/types.ts";
import { t3Threads } from "./index.ts";
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
  const threads = t3Threads(models, { home: (await t3()).home });
  const first = await threads.start({ ...request, key: "slack-message-1" });
  expect(first).toEqual({ id: "thread-1", url: "https://app.t3.codes/threads/env-1/thread-1" });
  expect(await threads.start({ ...request, key: "slack-message-1" })).toEqual(first);
  expect((await threads.start({ ...request, key: "slack-message-2" })).id).toBe("thread-2");
});

test("the model role starts the thread with that row's provider, model, and effort", async () => {
  const stub = await t3();
  await t3Threads(models, { home: stub.home }).start({ ...request, key: "k", modelRole: "lookup" });
  const launch = stub.rpcCalls.find((call) => call.tag === "orchestration.launchThread");
  expect(launch?.payload).toMatchObject({ title: request.title, initialMessage: { text: request.prompt }, modelSelection: { instanceId: "codex", model: "gpt-small", options: [{ id: "reasoningEffort", value: "medium" }] } });
});

test("a role the model table lacks fails with a sentence that names it", async () => {
  const stub = await t3();
  await expect(t3Threads(models, { home: stub.home }).start({ ...request, key: "k", modelRole: "review" })).rejects.toThrow("The model table of your AI plan has no review row");
  expect(stub.rpcCalls).toEqual([]);
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
