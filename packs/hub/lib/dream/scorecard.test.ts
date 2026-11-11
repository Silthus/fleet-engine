import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitEnv, spawnGit, tempDirs } from "../../../../src/testing/git.ts";
import { spawnAsync } from "../../../../src/testing/spawn.ts";
import { readMemories, recordRuns, scorecardText, weekOf } from "./scorecard.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const now = Date.parse("2026-11-05T04:10:00Z");

async function memoryRepo() {
  const checkout = temp.make("fleet-memory-");
  await spawnGit(checkout, "init", "--quiet", "-b", "main");
  const commit = async (files: Record<string, string>, message: string, date: string) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(checkout, path, ".."), { recursive: true });
      writeFileSync(join(checkout, path), text);
    }
    await spawnAsync(["git", "add", "-A"], { cwd: checkout, env: gitEnv });
    await spawnAsync(["git", "commit", "--quiet", "-m", message], { cwd: checkout, env: { ...gitEnv, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  };
  await commit({ "MEMORY.md": "# Memory\n- [Tests](tech/run-tests.md)\n", "tech/run-tests.md": "---\nname: run-tests\n---\nRun them.\n" }, "Add: run-tests\n\nTopics: test-first", "2026-10-20T00:00:00Z");
  await commit({ "dreams/2026-10-20.md": "report\n" }, "Report", "2026-10-20T01:00:00Z");
  return checkout;
}

const reader = (checkout: string) => async (args: string[]) => (await spawnGit(checkout, ...args)) + "\n";

test("readMemories reads each memory with the topics of its commits, and skips the index and the dream reports", async () => {
  const checkout = await memoryRepo();
  const memories = await readMemories(checkout, reader(checkout));
  expect(memories.map((memory) => [memory.path, [...memory.topics].sort(), memory.addedAt.slice(0, 10)])).toEqual([["tech/run-tests.md", ["run-tests", "test-first"], "2026-10-20"]]);
});

test("readMemories reads the memories of a memory.subtree folder by their paths in that folder", async () => {
  const repo = temp.make("fleet-memory-repo-");
  await spawnGit(repo, "init", "--quiet", "-b", "main");
  for (const [path, text] of Object.entries({ "memory/MEMORY.md": "# Memory\n- [Tests](tech/run-tests.md)\n", "memory/tech/run-tests.md": "---\nname: run-tests\n---\nRun them.\n", "app/notes.md": "not memory\n" })) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  await spawnAsync(["git", "add", "-A"], { cwd: repo, env: gitEnv });
  await spawnAsync(["git", "commit", "--quiet", "-m", "Add: run-tests\n\nTopics: test-first"], { cwd: repo, env: { ...gitEnv, GIT_COMMITTER_DATE: "2026-10-20T00:00:00Z", GIT_AUTHOR_DATE: "2026-10-20T00:00:00Z" } });
  const checkout = join(repo, "memory");
  const memories = await readMemories(checkout, reader(checkout));
  expect(memories.map((memory) => [memory.path, [...memory.topics].sort()])).toEqual([["tech/run-tests.md", ["run-tests", "test-first"]]]);
});

test("recordRuns copies each analyzed session into the ledger without its text, and the scorecard counts a repeat on a remembered topic", async () => {
  const checkout = await memoryRepo();
  const state = temp.make("fleet-dream-state-");
  const run = join(state, "2026-10-28");
  mkdirSync(join(run, "digests"), { recursive: true });
  mkdirSync(join(run, "findings"), { recursive: true });
  const digest = { machine: "devbox-1", provider: "claude", session: "s-1", cwd: "/x", repo: "app", model: "m", startedAt: "2026-10-27T10:00:00Z", endedAt: "2026-10-27T11:00:00Z", toolCalls: 1, skills: [], memoryReads: [], memoryWrites: [], tokens: 5, entries: [{ at: "", role: "user", text: "secret words" }] };
  writeFileSync(join(run, "digests", "a.json"), JSON.stringify(digest));
  writeFileSync(join(run, "findings", "a.json"), JSON.stringify({ taskType: "fix", findings: [{ kind: "repeated-failure", topic: "test-first", scope: "app", reach: "general", claim: "c", evidence: "e", memory: "", importance: 2 }] }));
  expect(recordRuns(state, now)).toBe(1);
  expect(readFileSync(join(state, "ledger.json"), "utf8")).not.toContain("secret words");
  const text = await scorecardText(state, checkout, reader(checkout), now);
  expect(text).toContain(`| Week of | ${weekOf("2026-10-27").slice(5)} |`);
  expect(text).toContain("| 1. Repeat mistakes on remembered topics, per 100 sessions | 100.0 |");
  expect(text).toContain("1. `tech/run-tests.md`: recurs and was never opened (1): sharpen its index line");
  expect(text).not.toContain("holdout");
});
