import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { missesPath, readMisses } from "./proof-misses.ts";
import { checkout, cleanFixtures, fakeModel, recordingModel, reviewHead, settings } from "./proof-testing.ts";

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

test("an eval records each reviewer in its panel slot, so reclaiming the slot of a dead eval stops its reviewer", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet the new member\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  await reviewHead(pr);
  await pr.fleet("miss", "--source", "human", "--finding", "The greeting names no member");
  await pr.fleet("miss", "--source", "bot", "--finding", "The greeting skips the welcome email");
  pr.env.FLEET_SETTINGS = JSON.stringify({ ...settings, "pull-requests.panelSlots": 1 });
  pr.panel.onPause = () => new Promise((done) => setImmediate(done));
  const slot = join(pr.home, ".local/state/fleet/proof/.panel-slots/0");
  const [first, seen, block] = ["first", "seen", "block"].map((name) => join(pr.home, name));
  Bun.spawnSync(["mkfifo", block]);
  const dead = Bun.spawnSync(["true"]).pid;
  pr.env.FLEET_PROOF_REVIEWER = `cat >/dev/null; if mkdir "${first}" 2>/dev/null; then
until grep -qs '"reviewer":'$$ "${slot}"; do :; done; cp "${slot}" "${seen}"
sed 's/"pid":[0-9]*/"pid":${dead}/' "${seen}" > "${slot}.dead"; mv "${slot}.dead" "${slot}"; exec cat "${block}"
else echo "No findings."; fi`;
  pr.env.FLEET_PROOF_REVIEWER_MODEL = "stub-reviewer";
  pr.env.FLEET_PROOF_EVAL_JUDGE = "echo 'NOT NAMED: the review has no findings'";

  const scored = await pr.fleet("eval");
  expect(JSON.parse(readFileSync(seen, "utf8"))).toMatchObject({ pid: process.pid, reviewer: expect.any(Number) });
  expect(scored.output).toContain(": failed: the reviewer stub-reviewer gave no findings (stopped by SIGKILL");
  expect(scored.output).toContain(": missed: the review has no findings");
});

test("an eval records its judge in its panel slot, so reclaiming the slot of a dead eval stops its judge", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "greet the new member\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  await reviewHead(pr);
  await pr.fleet("miss", "--source", "human", "--finding", "The greeting names no member");
  await pr.fleet("miss", "--source", "bot", "--finding", "The greeting skips the welcome email");
  pr.env.FLEET_SETTINGS = JSON.stringify({ ...settings, "pull-requests.panelSlots": 1 });
  pr.panel.onPause = () => new Promise((done) => setImmediate(done));
  const slot = join(pr.home, ".local/state/fleet/proof/.panel-slots/0");
  const [first, seen, block] = ["first", "seen", "block"].map((name) => join(pr.home, name));
  Bun.spawnSync(["mkfifo", block]);
  const dead = Bun.spawnSync(["true"]).pid;
  pr.env.FLEET_PROOF_REVIEWER = "cat >/dev/null; echo 'feature.txt:1: the greeting names no member'";
  pr.env.FLEET_PROOF_EVAL_JUDGE = `cat >/dev/null; if mkdir "${first}" 2>/dev/null; then
until grep -qs '"reviewer":'$$'}' "${slot}"; do :; done; cp "${slot}" "${seen}"
sed 's/"pid":[0-9]*/"pid":${dead}/' "${seen}" > "${slot}.dead"; mv "${slot}.dead" "${slot}"; exec cat "${block}"
else echo 'NOT NAMED: no finding is about email'; fi`;
  pr.env.FLEET_PROOF_EVAL_JUDGE_MODEL = "stub-judge";

  const scored = await pr.fleet("eval");
  expect(JSON.parse(readFileSync(seen, "utf8"))).toMatchObject({ pid: process.pid, reviewer: expect.any(Number) });
  expect(scored.output).toContain(": failed: the judge stub-judge gave no verdict (stopped by SIGKILL");
  expect(scored.output).toContain(": missed: no finding is about email");
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

test("a miss keeps the range the review read when it was reserved, after the base moves", async () => {
  const pr = checkout();
  const base = pr.git("rev-parse", "origin/main");
  const first = pr.commit("feature.txt", "greet\n");
  pr.commit("feature.txt", "greet the new member\n");
  const head = await reviewHead(pr);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "reviews/1/round.json"), "utf8"))).toMatchObject({ scope: "full", from: base });

  pr.git("update-ref", "refs/remotes/origin/main", first);
  pr.git("update-ref", "refs/heads/main", first);
  expect((await pr.fleet("miss", "--source", "human", "--finding", "The greeting names no member")).code).toBe(0);
  expect(JSON.parse(readFileSync(join(pr.home, ".local/state/fleet/proof/misses.jsonl"), "utf8").trim())).toMatchObject({ base, head, scope: "full" });
});
