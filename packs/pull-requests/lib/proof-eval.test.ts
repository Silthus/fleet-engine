import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { missesPath, readMisses } from "./proof-misses.ts";
import { checkout, cleanFixtures, fakeModel, recordingModel, reviewHead } from "./proof-testing.ts";

afterEach(cleanFixtures);

test("fleet proof miss records a case only for a commit that a finished review read, with the diff range that review read", async () => {
  const pr = checkout();
  const base = pr.git("rev-parse", "main");
  pr.commit("feature.txt", "greet the new member\n");
  const misses = join(pr.home, ".local/state/fleet/proof/misses.jsonl");
  const miss = (...args: string[]) => pr.fleet("miss", "--finding", "The greeting names no member", ...args);

  await expect(miss("--source", "customer")).rejects.toThrow("human, bot, ci, rollback, revert");
  await expect(miss("--source", "human", "--line", "1")).rejects.toThrow("--line needs --file");
  await expect(miss("--source", "human")).rejects.toThrow("No finished review");
  const head = await reviewHead(pr);

  expect((await miss("--source", "human", "--file", "feature.txt", "--line", "1", "--url", "https://github.com/example/product/pull/42#r1")).code).toBe(0);
  await expect(miss("--source", "bot")).rejects.toThrow("already recorded");
  const lines = readFileSync(misses, "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    repo: "example/product", pr: 42, commit: head, source: "human", finding: "The greeting names no member", file: "feature.txt", line: 1,
    base, head, scope: "full", round: "round 1", reviewer: "gpt-6.1-sol", title: "Greet new members", at: expect.any(String), id: expect.any(String),
  });
  expect(statSync(misses).mode & 0o777).toBe(0o600);
  expect(missesPath(pr.home)).toBe(misses);
  expect(await readMisses(pr.home)).toEqual([JSON.parse(lines[0]!)]);
});

test("fleet proof eval reruns the reviewer on each miss at its commit, scores it with the judge, and compares recall with the previous run", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet the new member\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  await reviewHead(pr);
  await pr.fleet("miss", "--source", "human", "--finding", "The greeting names no member");
  await pr.fleet("miss", "--source", "bot", "--finding", "The greeting skips the welcome email");
  const misses = join(pr.home, ".local/state/fleet/proof/misses.jsonl");
  const [human, bot] = readFileSync(misses, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { id: string });
  writeFileSync(misses, JSON.stringify({ ...bot, id: "elsewhere", repo: "example/other" }) + "\n", { flag: "a" });
  const reviewer = fakeModel(pr, "REVIEWER", "1. [high] feature.txt:1 names no member.");
  pr.env.FLEET_PROOF_EVAL_JUDGE = "if grep -q 'welcome email'; then echo 'NOT NAMED: no finding is about email'; else echo 'NAMED: the feature.txt:1 finding'; fi";
  await expect(pr.fleet("eval", "--checkout", "example/other")).rejects.toThrow("--checkout takes <owner/name>=<path>");

  const first = await pr.fleet("eval");
  expect(first.code).toBe(0);
  for (const line of [`${human!.id} example/product#42 (human): caught`, `${bot!.id} example/product#42 (bot): missed`, "elsewhere example/other#42 (bot): skipped: no checkout of example/other",
    "recall human: 1/1 (100%)", "recall bot: 0/1 (0%)", "recall overall: 1/2 (50%)", "previous run: none"]) expect(first.output).toContain(line);
  expect(reviewer.prompts().at(-1)).toContain("+greet the new member");
  expect(reviewer.prompts().at(-1)).toContain("from the model family that did not write it");
  expect(reviewer.prompts().at(-1)).toMatch(/The full diff is in \S+\/diff\.patch;/);
  expect(pr.git("worktree", "list").split("\n")).toHaveLength(1);

  pr.env.FLEET_PROOF_EVAL_JUDGE = "echo 'NAMED: the reviewer named it'";
  const second = await pr.fleet("eval", "--case", bot!.id);
  expect(second.output).toContain("0/1 (0%) on the 1 shared case(s), now 1/1 (100%)");
  expect(second.output).toContain(`${bot!.id}: missed -> caught`);
  const runs = readFileSync(join(pr.home, ".local/state/fleet/proof/evals.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(runs).toHaveLength(2);
  expect(runs[1]).toMatchObject({ reviewer: expect.stringContaining("command:"), promptHash: runs[0].promptHash, cases: [{ id: bot!.id, outcome: "caught", findings: expect.stringContaining("names no member") }] });
});

test("without a replacement command, the eval judge runs the lookup row of the model table", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet the new member\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  await reviewHead(pr);
  await pr.fleet("miss", "--source", "ci", "--finding", "The greeting names no member");
  fakeModel(pr, "REVIEWER", "No findings.");
  const claude = recordingModel(pr, "claude", "NOT NAMED: the review has no findings");

  const scored = await pr.fleet("eval");
  expect(scored.output).toContain("(ci): missed: the review has no findings");
  expect(claude.calls()).toEqual([expect.stringMatching(/^-p --model lookup-model --effort medium /)]);
  expect(claude.prompt()).toContain("<known-problem>\nThe greeting names no member\n</known-problem>");
  expect(JSON.parse(readFileSync(join(pr.home, ".local/state/fleet/proof/evals.jsonl"), "utf8"))).toMatchObject({ judge: "lookup-model" });
});
