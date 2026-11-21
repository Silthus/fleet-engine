import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnAsync } from "../../../src/testing/spawn.ts";
import { answeredFindings, reviewedFindings } from "./proof.ts";
import { answerFixed, checkout, cleanFixtures, fakeModel, lockHolder, finishRound, fixture, graded, markPanel, models, recordingModel, settings, stuckRoundLock, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

async function panelReview(pr: Checkout, findings = "(none)") {
  const changed = (await pr.git("diff", "--name-only", "refs/remotes/origin/main...HEAD")).split("\n").filter(Boolean);
  fakeModel(pr, "REVIEWER", `FINDINGS:\n${findings}\nCOVERED: ${changed.join(", ")}\n`);
  await pr.hedge("review", "--lens", "correctness");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  return pr.git("rev-parse", "HEAD");
}

const continueArbiter = (record = "/dev/null") => `cat > "${record}"; echo CONTINUE`;

async function savedPanel(pr: Checkout, findings: string) {
  await pr.hedge("review-start", "--scope", "full");
  writeFileSync(join(pr.repository, "findings.md"), findings);
  await pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md");
  markPanel(pr, "1");
}

const lensNames = (output: string) => JSON.parse(output.split("\n")[0]!).lenses.map(({ name }: { name: string }) => name);

test("minor and nit findings need no answer, while a blocker, a major, a finding without severity, or a TESTS item does, and the arbiter reads only blockers and majors", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  const panel = await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  await savedPanel(pr, [
    "FINDINGS:",
    "- feature.txt:1 | major | Correctness | the greeting drops the name -> members see no name | greet by name | anchor: new",
    "- feature.txt:1 | minor | Design | a helper could go -> one more name | inline it | anchor: new",
    "- nit | feature.txt:1 | the word reads oddly | anchor: new",
    "- feature.txt:1 the greeting has no severity | anchor: new",
    "COVERED: feature.txt",
    "### **TESTS:**",
    "- feature.test.ts:3 asserts the call count of greet",
    "",
  ].join("\n"));

  const gate = await pr.hedge("gate");
  expect(gate.code).toBe(1);
  expect(gate.output).toContain("review: round 1 has unanswered findings 1, 4, 5;");
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in 1a2b3c4: the greeting names the member.\n");
  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer findings 4, 5 too");
  const testsFixed = "5. fixed in 2b3c4d5: the test asserts the greeting.\n";
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in 1a2b3c4: the greeting names the member.\n4. known: listed under Known issues.\n" + testsFixed);
  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer a finding \"known\" only once the review budget of 6 reviews is spent; 1 ran");
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in 1a2b3c4: the greeting names the member.\n4. rejected: the greeting is the fixture's.\n" + testsFixed);
  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
  expect((await pr.hedge("gate")).code).toBe(0);

  const fixes = await pr.commit("feature.txt", "new member\n");
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  await finishRound(pr, "2");
  await pr.commit("feature.txt", "new members\n");
  const arbiter = join(pr.home, "arbiter-prompt.txt");
  pr.env.HEDGE_REVIEW_ARBITER = continueArbiter(arbiter);
  expect((await pr.hedge("review-start", "--scope", "final", "--base", fixes)).code).toBe(0);
  const prompt = readFileSync(arbiter, "utf8");
  expect(prompt).toContain("the greeting drops the name");
  expect(prompt).toContain("the greeting has no severity");
  expect(prompt).not.toContain("a helper could go");
  expect(prompt).not.toContain("the word reads oddly");
  expect(prompt).not.toContain("asserts the call count");
});

test("the Anchor check an author saves with the findings repeats them, so its notes need no answer and spend no review", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 1 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: lensAnswer("(none)") });
  await pr.commit("feature.txt", "greet the member\n");
  expect((await pr.hedge("review-start", "--scope", "final", "--base", panel)).output).toContain(`"id":"final-1"`);
  const answer = "- minor | feature.txt:1 | the word reads oddly | anchor: greet the guest";
  await finishWith(pr, "final-1", [
    answer,
    "",
    "## Anchor check",
    "",
    "hedge compared each finding's anchor with the diff and with earlier reviews of this PR.",
    "",
    `- Not in the diff, so check it before triage: ${answer}`,
    "",
  ].join("\n"));
  await pr.commit("feature.txt", "greet every member\n");

  expect((await pr.hedge("gate")).output).not.toContain("unanswered findings");
  await expect(answerKnown(pr, "final-1", 1)).rejects.toThrow(spentOf(1, 0));
});

test("a reviewer who quotes the Anchor check heading keeps every finding after it, so the gate asks for each blocker", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await cannedPanel(pr, {
    others: lensAnswer([
      "- feature.txt:1 | minor | Correctness | the reply copies a heading from old output: | drop it | anchor: greet",
      "## Anchor check",
      "- feature.txt:1 | blocker | Correctness | the greeting drops the name | greet by name | anchor: greet",
    ].join("\n")),
    design: lensAnswer([
      "## Anchor check",
      "",
      "hedge compared each finding's anchor with the diff and with earlier reviews of this PR.",
      "",
      "- feature.txt:1 | blocker | Design | the greeting has no owner | name one | anchor: greet",
    ].join("\n")),
  });

  expect((await pr.hedge("gate")).output).toContain("review: round 1 has unanswered findings 2, 3, 5, 7;");
});

test("a TESTS item keeps its number when a stored review ends with an Anchor check, so a saved answer still answers it", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await pr.hedge("review-start", "--scope", "full");
  await finishWith(pr, "1", [
    "- minor | feature.txt:1 | the word reads oddly | anchor: old",
    "TESTS:",
    "- feature.test.ts:3 asserts the call count of greet",
    "",
    "## Anchor check",
    "",
    "fleet compared each finding's anchor with the diff and with earlier reviews of this PR.",
    "",
    "- Not in the diff, so check it before triage: - minor | feature.txt:1 | the word reads oddly | anchor: old",
    "- 1 finding quotes no anchor.",
    "",
  ].join("\n"));
  writeFileSync(join(pr.repository, "responses.md"), "1. rejected: the word is the fixture's.\n");
  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer findings 4 too");
  writeFileSync(join(pr.repository, "responses.md"), "4. fixed in 1a2b3c4: the test asserts the greeting.\n");

  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
});

const anchorCheck = (notes: string[]) => ["", "## Anchor check", "", "hedge compared each finding's anchor with the diff and with earlier reviews of this PR.", "", ...notes, ""];
const proseBesideTests = ["The greeting drops the name.", "TESTS:", "- feature.test.ts:3 asserts the call count of greet", ...anchorCheck(["- 1 finding quotes no anchor."])];
const proseBaseItems = ["- 1 finding quotes no anchor.", "- feature.test.ts:3 asserts the call count of greet"];
const storedShapes = [
  { shape: "prose, TESTS items, and an Anchor check", findings: proseBesideTests.join("\n"), baseItems: proseBaseItems, baseAnswered: [1, 2], recovered: "The greeting drops the name." },
  { shape: "findings and an Anchor check", findings: ["- major | feature.txt:1 | the greeting drops the name | anchor: greet", "- minor | feature.txt:1 | the word reads oddly | anchor: old", "TESTS:", "- feature.test.ts:3 asserts the call count of greet", ...anchorCheck(["- Not in the diff, so check it before triage: - minor | feature.txt:1 | the word reads oddly | anchor: old", "- 1 finding quotes no anchor."])].join("\n"), baseItems: ["- major | feature.txt:1 | the greeting drops the name | anchor: greet", "- minor | feature.txt:1 | the word reads oddly | anchor: old", "- Not in the diff, so check it before triage: - minor | feature.txt:1 | the word reads oddly | anchor: old", "- 1 finding quotes no anchor.", "- feature.test.ts:3 asserts the call count of greet"], baseAnswered: [1, 3, 4, 5], recovered: undefined },
  { shape: "CRLF line endings, prose, TESTS items, and an Anchor check", findings: proseBesideTests.join("\r\n"), baseItems: proseBaseItems, baseAnswered: [1, 2], recovered: "The greeting drops the name." },
];

for (const { shape, findings, baseItems, baseAnswered, recovered } of storedShapes) test(`a response the base CLI accepted for a stored review with ${shape} answers the same items, and only a newly recovered prose finding needs an answer`, async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await pr.hedge("review-start", "--scope", "full");
  await finishWith(pr, "1", findings);
  const answer = (number: number) => `${number}. rejected: the answer the base CLI took for item ${number}.`;
  const saved = baseAnswered.map(answer).join("\n") + "\n";
  writeFileSync(join(pr.pullRequest, "reviews/1/responses.md"), saved);

  const read = answeredFindings(findings, saved).findings;
  expect(read.slice(0, baseItems.length).map(({ text, answer }) => [text, answer?.text])).toEqual(baseItems.map((text, index) => [text, baseAnswered.includes(index + 1) ? answer(index + 1) : undefined]));
  expect(read.slice(baseItems.length).map(({ text, answer }) => [text, answer])).toEqual(recovered ? [[recovered, undefined]] : []);
  const recoveredNumber = baseItems.length + 1;
  const gate = (await pr.hedge("gate")).output;
  if (!recovered) { expect(gate).not.toContain("unanswered findings"); return; }
  expect(gate).toContain(`review: round 1 has unanswered findings ${recoveredNumber};`);
  writeFileSync(join(pr.repository, "responses.md"), saved);
  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow(`Answer findings ${recoveredNumber} too`);
  writeFileSync(join(pr.repository, "responses.md"), saved + `${recoveredNumber}. fixed in 1a2b3c4: the greeting names the member.\n`);
  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
  expect((await pr.hedge("gate")).output).not.toContain("unanswered findings");
});

test("a review with only TESTS items and an Anchor check has no prose finding, so the gate asks only for the TESTS item", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await pr.hedge("review-start", "--scope", "full");
  await finishWith(pr, "1", [
    "TESTS:",
    "",
    "- feature.test.ts:3 asserts the call count of greet | anchor: greet(",
    "",
    "## Anchor check",
    "",
    "fleet compared each finding's anchor with the diff and with earlier reviews of this PR.",
    "",
    "- Seen before in final read 2: feature.test.ts: `greet(`",
    "",
  ].join("\n"));

  expect((await pr.hedge("gate")).output).toContain("review: round 1 has unanswered findings 2;");
});

test("a saved review with CRLF line endings reads its Anchor check notes as notes, so only the TESTS item needs an answer", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await pr.hedge("review-start", "--scope", "full");
  await finishWith(pr, "1", [
    "- minor | feature.txt:1 | the word reads oddly | anchor: old",
    "TESTS:",
    "- feature.test.ts:3 asserts the call count of greet",
    "",
    "## Anchor check",
    "",
    "hedge compared each finding's anchor with the diff and with earlier reviews of this PR.",
    "",
    "- 1 finding quotes no anchor.",
    "- Not in the diff, so check it before triage: - minor | feature.txt:1 | the word reads oddly | anchor: old",
    "",
  ].join("\r\n"));

  expect((await pr.hedge("gate")).output).toContain("review: round 1 has unanswered findings 4;");
  writeFileSync(join(pr.repository, "responses.md"), "4. fixed in 1a2b3c4: the test asserts the greeting.\n");
  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
  expect((await pr.hedge("gate")).output).not.toContain("unanswered findings");
});

test("TESTS items number after every finding, so a TESTS block between lenses moves no finding's number", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  fakeModel(pr, "REVIEWER", "FINDINGS:\n- feature.txt:1 | minor | the greeting reads plain | anchor: new\nCOVERED: feature.txt\nTESTS:\n- feature.test.ts:3 asserts the call count of greet\n");
  await pr.hedge("review", "--lens", "correctness", "--lens", "design");
  await pr.hedge("review", "--wait");
  writeFileSync(join(pr.repository, "responses.md"), "1. rejected: noted.\n");
  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer findings 5, 6, 7, 8 too");
});

test("a blocker in the Known issues section of the PR body holds the merge, and a major there does not", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  await panelReview(pr);

  pr.pullRequestState({ body: "Greets new members.\n\n## Known issues\n\n- major: feature.txt:1 the greeting is plain\n" });
  expect((await pr.hedge("gate")).code).toBe(0);

  pr.pullRequestState({ body: "Greets new members.\n\n## Known issues (2)\n\n- major: feature.txt:1 the greeting is plain\n- blocker: feature.txt:1 the greeting drops the name\n\n## Tests\n\n- blocker: not a known issue\n" });
  const held = await pr.hedge("gate");
  expect(held.code).toBe(1);
  expect(held.output).toContain("known issues: an open blocker holds the merge: - blocker: feature.txt:1 the greeting drops the name");
  expect(JSON.parse((await pr.hedge("gate", "--json")).output)).toMatchObject({ held: "known issues: an open blocker holds the merge: - blocker: feature.txt:1 the greeting drops the name" });
  pr.pullRequestState({ body: "Greets new members.\n\n```md\n## Known issues\n\n- major: feature.txt:1 an example\n```\n\n## Known issues\n\n- blocker: feature.txt:1 the greeting drops the name\n" });
  expect((await pr.hedge("gate")).output).toContain("known issues: an open blocker holds the merge: - blocker: feature.txt:1 the greeting drops the name");
});

test("a prose finding stays a finding when the review also lists TESTS items", () => {
  const items = reviewedFindings("FINDINGS:\nThe greeting drops the name.\nCOVERED: a.ts\nTESTS:\n- a.test.ts:1 asserts a mock\n");
  expect(items).toEqual(["The greeting drops the name.", "- a.test.ts:1 asserts a mock"]);
});

test("a test-only diff at low merge risk gets the Read tier: one combined Correctness and Risk lens on the other family, then, once both find a major, no fixes round", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "low") });
  await pr.commit("feature.test.ts", Array.from({ length: 80 }, (_, line) => `test("greets ${line}", () => {});`).join("\n") + "\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const reviewer = fakeModel(pr, "REVIEWER", "FINDINGS:\n- feature.test.ts:1 | major | Correctness | the test greets no one | greet a member | anchor: greets\nCOVERED: feature.test.ts\n");

  const started = await pr.hedge("review");
  expect(JSON.parse(started.output.split("\n")[0]!)).toMatchObject({ tier: { name: "read" }, lenses: [{ name: "combined", family: "gpt" }] });
  expect(started.output).toContain("review tier: read: merge-risk grade low, 0 authored production lines");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  const [brief, ...others] = reviewer.prompts();
  expect(others).toEqual([]);
  expect(brief).toContain("Trace one concrete input through each new branch.");
  expect(brief).toContain("Weigh the blast radius of each changed path.");
  expect((await pr.hedge("show")).output).toContain("review tier: read: merge-risk grade low, 0 authored production lines");
  const reviewed = await pr.git("rev-parse", "HEAD");

  await pr.commit("helper.ts", "export const name = \"member\";\n");
  expect((await pr.hedge("gate")).code).toBe(1);
  reviewer.answer("FINDINGS:\n- helper.ts:1 | major | Correctness | the name drops the member | name the member | anchor: member\nCOVERED: helper.ts\n");
  expect((await pr.hedge("review", "--scope", "final", "--base", reviewed)).code).toBe(0);
  await pr.commit("helper.ts", "export const name = \"new member\";\n");
  await expect(pr.hedge("review", "--scope", "fixes", "--base", reviewed)).rejects.toThrow("The review budget of 2 reviews is spent.");
});

test("a 120-line diff at low merge risk gets the Pair tier: correctness and risk on the other family and fresh eyes on the author's", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "low") });
  await pr.commit("feature.ts", Array.from({ length: 120 }, (_, line) => `export const greet${line} = (name: string) => name;`).join("\n") + "\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  fakeModel(pr, "REVIEWER", "FINDINGS:\n(none)\nCOVERED: feature.ts\n");

  const started = await pr.hedge("review");
  expect(JSON.parse(started.output.split("\n")[0]!)).toMatchObject({
    tier: { name: "pair", why: "merge-risk grade low, 120 authored production lines" },
    lenses: [{ name: "correctness", family: "gpt" }, { name: "risk", family: "gpt" }, { name: "fresh-eyes", family: "claude" }],
  });
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect((await pr.hedge("gate")).output).toContain("review: HEAD reviewed in round 1");
});

test("a high merge-risk diff gets the Panel tier without sweep or the author's Team perspective, and --lens adds to it", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("critical (b)", "high") });
  await pr.commit("feature.ts", "export const greet = (name: string) => name;\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  fakeModel(pr, "REVIEWER", "FINDINGS:\n(none)\nCOVERED: feature.ts\n");

  const started = await pr.hedge("review", "--lens", "security");
  expect(lensNames(started.output)).toEqual(["security", "fresh-eyes", "correctness", "risk", "design", "anti-overengineering"]);
  expect(started.output).toContain("review tier: panel: merge-risk grade high");
});

test("a merge-risk callout whose grade hedge cannot read gets the Pair tier, and a PR without a callout gets the Read tier", async () => {
  const tierAt = async (body: string, file = "feature.ts", content = "export const greet = (name: string) => name;\n") => {
    const pr = await checkout();
    pr.pullRequestState({ body });
    await pr.commit(file, content);
    await pr.hedge("require", "--none", "--reason", "fixture");
    fakeModel(pr, "REVIEWER", `FINDINGS:\n(none)\nCOVERED: ${file}\n`);
    return JSON.parse((await pr.hedge("review")).output.split("\n")[0]!).tier.name;
  };
  expect(await tierAt("Greets new members.\n\n<!-- merge-risk -->\n> **Merge risk: unclear**\n<!-- /merge-risk -->\n")).toBe("pair");
  expect(await tierAt("Greets new members.\n\n<!-- merge-risk -->\n> **Merge risk: low/medium**\n<!-- /merge-risk -->\n")).toBe("pair");
  expect(await tierAt("Greets new members.\n\n<!-- merge-risk -->\n> **Merge risk: low / medium**\n<!-- /merge-risk -->\n")).toBe("pair");
  expect(await tierAt("Greets new members.")).toBe("read");
  expect(await tierAt("Greets new members.", "greeter.bin", "greet\0member\n")).toBe("pair");
});

test("each reviewer runs without the user's harness, and its token use lands in lenses/<lens>.json and round.json", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const bin = pr.env.PATH!.split(":")[0]!;
  const calls = join(pr.home, "model-calls");
  const answer = "FINDINGS:\\n(none)\\nCOVERED: feature.txt\\n";
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$*" >> "${calls}"\ncat >/dev/null\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"${answer}","usage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":40,"output_tokens":7},"total_cost_usd":0.25}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "$*" >> "${calls}"\ncat >/dev/null\nfor arg in "$@"; do [ "$previous" = "-o" ] && printf '${answer}' > "$arg"; previous="$arg"; done\necho '{"type":"thread.started"}'\necho '{"type":"turn.completed","usage":{"input_tokens":30,"cached_input_tokens":20,"output_tokens":5}}'\n`, { mode: 0o755 });

  await pr.hedge("review");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  const lens = (name: string) => JSON.parse(readFileSync(join(pr.pullRequest, "reviews/1/lenses", `${name}.json`), "utf8"));
  expect(lens("fresh-eyes").usage).toEqual({ input: 12, cacheRead: 3, cacheWrite: 40, output: 7, costUsd: 0.25 });
  expect(lens("correctness").usage).toEqual({ input: 30, cacheRead: 20, output: 5 });
  const claudeCall = readFileSync(calls, "utf8").split("\n").find((line) => line.startsWith("-p "))!;
  for (const flag of ["--setting-sources  ", "--strict-mcp-config", "--no-session-persistence", "--output-format json"]) expect(claudeCall).toContain(flag);

  const reviewed = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.txt", "greet the member\n");
  expect((await pr.hedge("review", "--scope", "final", "--base", reviewed)).code).toBe(0);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "reviews/final-1/round.json"), "utf8")).usage).toEqual({ input: 30, cacheRead: 20, output: 5 });
});

test("at the budget a known answer settles a major the PR body lists by file:line, and a known blocker holds the merge", async () => {
  const pr = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 1, "pull-requests.reviewCeiling": 1 });
  await pr.commit("README.md", "Greet new members.\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  await savedPanel(pr, "FINDINGS:\n- README.md:1 | blocker | Correctness | the page names no member -> members see nothing | name them | anchor: Greet new members.\n- README.md:1 | major | Correctness | the page is terse -> members skim it | expand it | anchor: Greet new members.\nCOVERED: README.md\n");

  writeFileSync(join(pr.repository, "responses.md"), "1. rejected: the fixture names nobody.\n2. known: listed under Known issues.\n");
  await pr.hedge("respond", "--round", "1", "responses.md");
  const unlisted = await pr.hedge("gate");
  expect(unlisted.code).toBe(1);
  expect(unlisted.output).toContain("known issues: round 1 answers findings 2 known, but the \"## Known issues\" section of the PR body does not list their file:line");
  for (const item of ["feature.txt:1 another finding", "README.md:12 a later line", "docs/README.md:1 another file", "the page is terse"]) {
    pr.pullRequestState({ body: `Greets new members.\n\n## Known issues\n\n- major: ${item}\n` });
    expect((await pr.hedge("gate")).code).toBe(1);
  }
  pr.pullRequestState({ body: "Greets new members.\n\n## Known issues\n\n- major: README.md:1 the page is terse\n" });
  expect((await pr.hedge("gate")).code).toBe(0);

  writeFileSync(join(pr.repository, "responses.md"), "1. known: listed under Known issues.\n2. known: listed under Known issues.\n");
  await pr.hedge("respond", "--round", "1", "responses.md");
  const held = await pr.hedge("gate");
  expect(held.code).toBe(1);
  expect(held.output).toContain("known issues: round 1 answers findings 1 known, and an open blocker holds the merge");
});

test("a Read tier PR's combined lens reads with the Security lane's model when a Security lens is asked", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: "Greets new members." });
  await pr.commit("README.md", "Greet new members.\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  pr.env.HEDGE_MODELS = JSON.stringify([...models, { role: "security", work: "Deep security review", provider: "codex", model: "security-model", effort: "xhigh" }]);
  pr.env.HEDGE_PROOF_REVIEWER_MODEL = "candidate-model";
  const codex = recordingModel(pr, "codex", "FINDINGS:\n(none)\nCOVERED: README.md\n");

  await pr.hedge("review", "--lens", "correctness", "--lens", "security");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect(codex.calls().map((call) => call.split(" -s ")[0])).toEqual(['exec --json -m security-model -c model_reasoning_effort="xhigh"']);
});

test("a docs-only PR gets the combined lens in a checkout that has not fetched its base branch yet", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: "Greets new members." });
  await pr.commit("README.md", "Greet new members.\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const remote = join(fixture("hedge-proof-remote-"), "github.com/example/product.git");
  mkdirSync(remote, { recursive: true });
  await pr.git("init", "-q", "--bare", remote);
  await pr.git("push", "-q", remote, "refs/remotes/origin/main:refs/heads/main");
  await pr.git("remote", "set-url", "origin", remote);
  await pr.git("update-ref", "-d", "refs/remotes/origin/main");
  fakeModel(pr, "REVIEWER", "FINDINGS:\n(none)\nCOVERED: README.md\n");

  expect(lensNames((await pr.hedge("review")).output)).toEqual(["combined"]);
});

test("a Read tier PR keeps its panel read after a single read the author saved", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: "Greets new members." });
  const read = await pr.commit("README.md", "Greet new members.\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  expect((await pr.hedge("review-start", "--scope", "full")).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "- major | the page names no member | anchor: Greet new members.\n");
  await pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md");
  await answerFixed(pr, "1");
  await pr.commit("README.md", "Greet every new member.\n");
  expect((await pr.hedge("gate")).code).toBe(1);

  fakeModel(pr, "REVIEWER", "FINDINGS:\n(none)\nCOVERED: README.md\n");
  await pr.hedge("review", "--lens", "correctness", "--scope", "fixes", "--base", read);
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  expect((await pr.hedge("gate")).code).toBe(0);
});

test("an unfinished panel reruns with its own lenses after the merge risk changes", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "low") });
  await pr.commit("feature.ts", "export const greet = (name: string) => `hi ${name}`;\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const reviewer = fakeModel(pr, "REVIEWER", "Looks fine to me.");
  await pr.hedge("review");
  expect((await pr.hedge("review", "--wait")).code).toBe(1);

  pr.pullRequestState({ body: graded("non-critical", "high") });
  reviewer.answer("FINDINGS:\n(none)\nCOVERED: feature.ts\n");
  const rerun = await pr.hedge("review");
  expect(lensNames(rerun.output)).toEqual(["combined"]);
  expect(rerun.output).toContain("review tier: read: merge-risk grade low");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
});

test("the last read reads every fix since the panel commit with the Correctness lens", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  const panel = await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await panelReview(pr, "- feature.txt:1 | major | Correctness | the greeting names no member | name the member | anchor: greet");
  await answerFixed(pr, "1", 3);
  const fixes = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  await finishRound(pr, "2");
  const head = await pr.commit("feature.txt", "greet the new member\n");
  pr.env.HEDGE_REVIEW_ARBITER = continueArbiter();
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");

  expect((await pr.hedge("review", "--scope", "final", "--base", fixes)).code).toBe(0);
  const prompt = reviewer.prompts().at(-1)!;
  expect(prompt).toContain(`Review the change ${panel}..${head}`);
  expect(prompt).toContain("This is the last read: the diff holds every fix since the panel. Read it with the Correctness lens:\n\nTrace one concrete input through each new branch.");
  expect(prompt).toContain("-greet\n+greet the new member");
});

test("a first final read from the panel commit reads with the Correctness lens too", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  const panel = await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const reviewer = fakeModel(pr, "REVIEWER", "FINDINGS:\n(none)\nCOVERED: feature.txt\n");
  await pr.hedge("review", "--lens", "correctness", "--lens", "design");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  await pr.commit("feature.txt", "greet the member\n");
  reviewer.answer("No findings.");

  expect((await pr.hedge("review", "--scope", "final", "--base", panel)).code).toBe(0);
  expect(reviewer.prompts().at(-1)!).toContain("This is the last read: the diff holds every fix since the panel. Read it with the Correctness lens");
});

test("hedge proof miss records --introduced-by-fix on the case", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await panelReview(pr);

  const recorded = await pr.hedge("miss", "--source", "human", "--finding", "The fix drops the member's name", "--introduced-by-fix");
  expect(JSON.parse(recorded.output)).toMatchObject({ introducedByFix: true });
  await pr.hedge("miss", "--source", "bot", "--finding", "The greeting skips the welcome email");
  const cases = readFileSync(join(pr.home, ".local/state/hedge/proof/misses.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(cases.map((miss) => miss.introducedByFix)).toEqual([true, undefined]);
});

test("a revert of a PR commit, or a commit that only deletes test files, keeps the review, and a revert of a base commit does not", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "greet\n");
  await pr.commit("feature.test.ts", "test(\"greets\", () => {});\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await panelReview(pr);

  const fix = await pr.commit("feature.txt", "greet the member\n");
  expect((await pr.hedge("gate")).code).toBe(1);
  await pr.git("revert", "--no-edit", fix);
  const reverted = await pr.hedge("gate");
  expect(reverted.code).toBe(0);
  expect(reverted.output).toContain("revert of a PR commit");

  await pr.git("rm", "-q", "feature.test.ts");
  await pr.git("commit", "-q", "-m", "drop the test");
  const deleted = await pr.hedge("gate");
  expect(deleted.code).toBe(0);
  expect(deleted.output).toContain("test-only delta");

  const fixed = await pr.commit("feature.txt", "greet every member\n");
  await pr.commit("feature.test.ts", "test(\"greets every member\", () => {});\n");
  await pr.git("revert", "--no-edit", fixed);
  const apart = await pr.hedge("gate");
  expect(apart.code).toBe(0);
  expect(apart.output).toContain("revert of a PR commit and test-only delta");

  const branch = await pr.git("rev-parse", "--abbrev-ref", "HEAD");
  const before = await pr.git("rev-parse", "HEAD");
  await pr.git("checkout", "-q", "-b", "elsewhere", `${before}~1`);
  const elsewhere = await pr.commit("feature.txt", "greet\n");
  await pr.git("checkout", "-q", branch);
  await pr.git("revert", "--no-edit", elsewhere);
  expect((await pr.hedge("gate")).code).toBe(1);
  await pr.git("reset", "-q", "--hard", before);

  const again = await pr.commit("feature.txt", "greet the new member\n");
  await pr.git("update-ref", "refs/remotes/origin/main", again);
  await pr.git("revert", "--no-edit", again);
  expect((await pr.hedge("gate")).code).toBe(1);
});

test("deleting a test file that code imports needs a new review", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("policy.test.ts", "export const policy = 1;\n");
  await pr.commit("app.ts", "import { policy } from \"./policy.test.ts\";\nexport const app = policy;\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await panelReview(pr);
  await pr.git("rm", "-q", "policy.test.ts");
  await pr.git("commit", "-q", "-m", "drop the policy");
  expect((await pr.hedge("gate")).code).toBe(1);
});

test("a known answer waits for the budget of its own phase", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 2, "pull-requests.reviewCeiling": 2 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await panelReview(pr);
  const read = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "final", "--base", panel);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.hedge("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md");
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("review-start", "--scope", "final", "--phase", "babysit", "--base", read);
  writeFileSync(join(pr.repository, "findings.md"), "- major | feature.txt:1 | the member goes unnamed | anchor: greet the new member\n");
  await pr.hedge("review-finish", "--round", "final-2", "--reviewer", "gpt-6.1-sol", "findings.md");

  writeFileSync(join(pr.repository, "responses.md"), "1. known: listed under Known issues.\n");
  await expect(pr.hedge("respond", "--round", "final-2", "responses.md")).rejects.toThrow("only once the review budget of 2 reviews is spent; 1 ran");
});

test("respond refuses a known answer when as many reviews ran as the ceiling allows but a clean panel left the budget unspent", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 2 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: lensAnswer("(none)") });
  await pr.commit("feature.txt", "greet the member\n");
  expect((await pr.hedge("review-start", "--scope", "final", "--base", panel)).output).toContain(`"id":"final-1"`);
  await finishWith(pr, "final-1", major("the member goes unnamed"));

  writeFileSync(join(pr.repository, "responses.md"), "1. known: listed under Known issues.\n");
  await expect(pr.hedge("respond", "--round", "final-1", "responses.md")).rejects.toThrow("Answer a finding \"known\" only once the review budget of 2 reviews is spent; 1 ran");
});

test("a revert carries only from a reviewed commit before the reverted one", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await panelReview(pr);
  const first = await pr.commit("feature.txt", "greet the member\n");
  const second = await pr.commit("feature.txt", "greet the new member\n");
  await pr.hedge("review-start", "--scope", "final", "--base", panel);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.hedge("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md");

  await pr.git("revert", "--no-edit", second);
  expect((await pr.hedge("gate")).code).toBe(1);
  await pr.git("revert", "--no-edit", first);
  const back = await pr.hedge("gate");
  expect(back.code).toBe(0);
  expect(back.output).toContain(`final read carried from ${panel.slice(0, 7)}: revert of a PR commit`);

  const fix = await pr.commit("helper.txt", "names\n");
  const later = await pr.commit("other.txt", "uses the names\n");
  pr.env.HEDGE_REVIEW_ARBITER = continueArbiter();
  await pr.hedge("review-start", "--scope", "final", "--base", second);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.hedge("review-finish", "--round", "final-2", "--reviewer", "gpt-6.1-sol", "findings.md");
  expect(await pr.git("rev-parse", "HEAD")).toBe(later);
  await pr.git("revert", "--no-edit", fix);
  expect((await pr.hedge("gate")).code).toBe(1);
});

test("a review that another one overtakes while it weighs the budget backs out", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 2, "pull-requests.reviewCeiling": 3 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await panelReview(pr, "- feature.txt:1 | major | Correctness | the greeting drops the name | greet by name | anchor: greet");
  await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  await finishRound(pr, "2");
  const fixes = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.txt", "greet the new member\n");
  const [started, go] = ["started", "go"].map((name) => join(pr.home, name));
  await spawnAsync(["mkfifo", started, go]);
  pr.env.HEDGE_REVIEW_ARBITER = `cat >/dev/null; if mkdir "${pr.home}/first" 2>/dev/null; then echo > "${started}"; read line < "${go}"; fi; echo CONTINUE`;

  const slow = pr.hedge("review-start", "--scope", "fixes", "--base", fixes);
  await readFile(started, "utf8");
  await pr.hedge("review-start", "--scope", "final", "--base", fixes);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.hedge("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md");
  await writeFile(go, "go\n");

  await expect(slow).rejects.toThrow("Review final-1 started while this one weighed the budget");
  await expect(pr.hedge("show", "--round", "3")).rejects.toThrow("has no reservation");
});

test("a final read backs out when a panel round captured elsewhere turns into the latest counted review while it weighs the budget", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 1, "pull-requests.reviewCeiling": 20 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await panelReview(pr, "- feature.txt:1 | major | Correctness | the greeting drops the name | greet by name | anchor: greet");
  await pr.commit("feature.txt", "greet the member\n");
  pr.env.HEDGE_REVIEW_ARBITER = continueArbiter();
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  await finishRound(pr, "2");
  markPanel(pr, "2");
  const round = join(pr.pullRequest, "reviews/2/round.json");
  const captured = (by: string) => writeFileSync(round, JSON.stringify({ ...JSON.parse(readFileSync(round, "utf8")), capturedBy: by }));
  captured("fleet");
  await pr.commit("feature.txt", "greet the new member\n");
  const [started, go] = ["started", "go"].map((name) => join(pr.home, name));
  await spawnAsync(["mkfifo", started, go]);
  pr.env.HEDGE_REVIEW_ARBITER = `cat >/dev/null; echo > "${started}"; read line < "${go}"; echo CONTINUE`;

  const slow = pr.hedge("review-start", "--scope", "final", "--base", panel);
  await readFile(started, "utf8");
  captured("hedge");
  await writeFile(go, "go\n");

  await expect(slow).rejects.toThrow("The reviews changed while this one weighed the budget");
  expect(readdirSync(join(pr.pullRequest, "reviews")).sort()).toEqual(["1", "2"]);
});

test("of two final reads that weigh the same budget and leave the arbiter together on the same clock, exactly one reserves and the other says why it stops", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 1, "pull-requests.reviewCeiling": 20 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  let base = await panelReview(pr, "- feature.txt:1 | major | Correctness | the greeting drops the name | greet by name | anchor: greet");
  pr.env.HEDGE_REVIEW_ARBITER = continueArbiter();
  for (let read = 1; read <= 8; read++) {
    const head = await pr.commit("feature.txt", `greet ${read}\n`);
    await pr.hedge("review-start", "--scope", "final", "--base", base);
    writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
    await pr.hedge("review-finish", "--round", `final-${read}`, "--reviewer", "gpt-6.1-sol", "findings.md");
    base = head;
  }
  await pr.commit("feature.txt", "greet 9\n");
  const [started1, go1, started2, go2] = ["started1", "go1", "started2", "go2"].map((name) => join(pr.home, name));
  await spawnAsync(["mkfifo", started1, go1, started2, go2]);
  pr.env.HEDGE_REVIEW_ARBITER = `cat >/dev/null; if mkdir "${pr.home}/first" 2>/dev/null; then n=1; else n=2; fi; echo > "${pr.home}/started$n"; read line < "${pr.home}/go$n"; echo CONTINUE`;

  const first = pr.hedge("review-start", "--scope", "final", "--base", base);
  await readFile(started1, "utf8");
  const second = pr.hedge("review-start", "--scope", "final", "--base", base);
  await readFile(started2, "utf8");
  await Promise.all([writeFile(go1, "go\n"), writeFile(go2, "go\n")]);
  const results = await Promise.allSettled([first, second]);

  const reserved = results.filter((result) => result.status === "fulfilled");
  const stopped = results.filter((result) => result.status === "rejected");
  expect(reserved).toHaveLength(1);
  expect(reserved[0]!.value.output).toContain(`"id":"final-9"`);
  expect(stopped).toHaveLength(1);
  expect(String(stopped[0]!.reason)).toMatch(/A review is unfinished\. Finish it before a final read\.|then run this command again|Review final-9 started while this one weighed the budget/);
  await expect(pr.hedge("show", "--round", "final-10")).rejects.toThrow("has no reservation");
  await expect(pr.hedge("review-start", "--scope", "final", "--base", base)).rejects.toThrow("A review is unfinished");
});

async function fixesRoundDue(pr: Checkout) {
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await panelReview(pr, "- feature.txt:1 | major | Correctness | the greeting drops the name | greet by name | anchor: greet");
  await pr.commit("feature.txt", "greet the member\n");
  return { panel, reviews: join(pr.pullRequest, "reviews"), lock: join(pr.pullRequest, "reviews", "round.lock") };
}

test("a review takes over the budget lock of a hedge proof command that crashed, and leaves the lock free for the next review", async () => {
  const pr = await checkout();
  const { panel, reviews } = await fixesRoundDue(pr);
  await (await lockHolder(reviews)).crash();

  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", panel)).output).toContain(`"round":2`);
  await finishRound(pr, "2");
  const fixes = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.txt", "greet the new member\n");
  pr.env.HEDGE_REVIEW_ARBITER = continueArbiter();
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", fixes)).output).toContain(`"round":3`);
});

test.each(["hedge-proof-checkout-", "hedge-proof-o'brien-"])("a budget lock whose holder crashed and whose takeovers all crashed midway names the command that clears it, and the next review runs once that command ran, in a home named %s", async (prefix) => {
  const pr = await checkout(prefix);
  const { panel, reviews, lock } = await fixesRoundDue(pr);
  const listing = () => readdirSync(reviews).sort();
  const before = listing();
  await stuckRoundLock(reviews, 10);
  const stuckStart = () => pr.hedge("review-start", "--scope", "fixes", "--base", panel).then(() => "", (error: Error) => error.message);
  const stuck = await stuckStart();
  const clear = stuck.match(/then run (rm -f .*) and run this command again/)?.[1] ?? "";

  expect(stuck).toContain(`The lock ${lock} is stuck: its holder is gone, and 10 takeovers of it stopped before they ended. Check that no hedge proof command runs on this PR, then run rm -f `);
  expect(await stuckStart()).toContain(`The lock ${lock} is stuck`);
  expect((await spawnAsync(["sh", "-c", clear])).exitCode).toBe(0);
  expect(listing()).toEqual(before);
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", panel)).output).toContain(`"round":2`);
});

test("a review that leaves the arbiter while another command holds the budget lock stops before it reserves, and reserves once that command is done", async () => {
  const pr = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 1, "pull-requests.reviewCeiling": 3 });
  const { panel, reviews, lock } = await fixesRoundDue(pr);
  const [started, go] = ["started", "go"].map((name) => join(pr.home, name));
  await spawnAsync(["mkfifo", started, go]);
  pr.env.HEDGE_REVIEW_ARBITER = `cat >/dev/null; if mkdir "${pr.home}/first" 2>/dev/null; then echo > "${started}"; read line < "${go}"; fi; echo CONTINUE`;

  const waiting = pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  await readFile(started, "utf8");
  const holder = await lockHolder(reviews);
  try {
    await writeFile(go, "go\n");
    await expect(waiting).rejects.toThrow(`Process ${holder.pid}, another hedge proof command, works on ${reviews} and holds its lock ${lock}. Wait for it to end, then run this command again`);
    await expect(pr.hedge("show", "--round", "2")).rejects.toThrow("has no reservation");
  } finally { expect(await holder.release()).toBe(0); }
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", panel)).output).toContain(`"round":2`);
});

test("a fixes round backs out when a dropped unfinished final read is started again under the same name, phase, and start time while it weighs the budget", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 2, "pull-requests.reviewCeiling": 3 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await panelReview(pr, "- feature.txt:1 | major | Correctness | the greeting drops the name | greet by name | anchor: greet");
  const fix = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  writeFileSync(join(pr.repository, "findings.md"), "- major | feature.txt:1 | the member goes unnamed | anchor: greet the member\n");
  await pr.hedge("review-finish", "--round", "2", "--reviewer", "gpt-6.1-sol", "findings.md");
  await pr.commit("feature.txt", "greet the new member\n");
  const babysit = JSON.parse((await pr.hedge("review-start", "--scope", "final", "--phase", "babysit", "--base", fix)).output.split("\n")[0]!);
  expect(babysit).toMatchObject({ round: "final", id: "final-1" });
  const [started, go] = ["started", "go"].map((name) => join(pr.home, name));
  await spawnAsync(["mkfifo", started, go]);
  pr.env.HEDGE_REVIEW_ARBITER = `cat >/dev/null; if mkdir "${pr.home}/first" 2>/dev/null; then echo > "${started}"; read line < "${go}"; fi; echo CONTINUE`;

  const slow = pr.hedge("review-start", "--scope", "fixes", "--base", fix);
  await readFile(started, "utf8");
  try {
    rmSync(babysit.directory, { recursive: true, force: true });
    expect((await pr.hedge("review-start", "--scope", "final", "--phase", "babysit", "--base", fix)).output).toContain(`"id":"final-1"`);
  } finally {
    await writeFile(go, "go\n");
    await slow.catch(() => undefined);
  }

  await expect(slow).rejects.toThrow("The reviews changed while this one weighed the budget. Run this command again to weigh it anew");
  await expect(pr.hedge("show", "--round", "3")).rejects.toThrow("has no reservation");
  await expect(pr.hedge("show", "--round", "final-1")).resolves.toMatchObject({ code: 0 });
});

test("a fixes round backs out when a dropped final read's name is reused in the same millisecond while it weighs the budget, so it never opens past the ceiling", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 2, "pull-requests.reviewCeiling": 3 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await panelReview(pr, "- feature.txt:1 | major | Correctness | the greeting drops the name | greet by name | anchor: greet");
  const fix = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  writeFileSync(join(pr.repository, "findings.md"), "- major | feature.txt:1 | the member goes unnamed | anchor: greet the member\n");
  await pr.hedge("review-finish", "--round", "2", "--reviewer", "gpt-6.1-sol", "findings.md");
  await pr.commit("feature.txt", "greet the new member\n");
  const babysit = JSON.parse((await pr.hedge("review-start", "--scope", "final", "--phase", "babysit", "--base", fix)).output.split("\n")[0]!);
  expect(babysit).toMatchObject({ round: "final", id: "final-1" });
  const [started, go] = ["started", "go"].map((name) => join(pr.home, name));
  await spawnAsync(["mkfifo", started, go]);
  pr.env.HEDGE_REVIEW_ARBITER = `cat >/dev/null; if mkdir "${pr.home}/first" 2>/dev/null; then echo > "${started}"; read line < "${go}"; fi; echo CONTINUE`;

  const slow = pr.hedge("review-start", "--scope", "fixes", "--base", fix);
  await readFile(started, "utf8");
  try {
    rmSync(babysit.directory, { recursive: true, force: true });
    expect((await pr.hedge("review-start", "--scope", "final", "--base", fix)).output).toContain(`"id":"final-1"`);
    writeFileSync(join(pr.repository, "findings.md"), "- major | feature.txt:1 | the new member goes unnamed | anchor: greet the new member\n");
    await pr.hedge("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md");
  } finally {
    await writeFile(go, "go\n");
    await slow.catch(() => undefined);
  }

  await expect(slow).rejects.toThrow("The reviews changed while this one weighed the budget. Run this command again to weigh it anew");
  await expect(pr.hedge("show", "--round", "3")).rejects.toThrow("has no reservation");
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", fix)).rejects.toThrow("The review budget of 3 reviews is spent");
});

test("a review that cannot read an earlier reservation while it weighs the budget reserves nothing, so a retry is not blocked as unfinished", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 2, "pull-requests.reviewCeiling": 3 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await panelReview(pr, "- feature.txt:1 | major | Correctness | the greeting drops the name | greet by name | anchor: greet");
  await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  await finishRound(pr, "2");
  const fixes = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.txt", "greet the new member\n");
  const [started, go] = ["started", "go"].map((name) => join(pr.home, name));
  await spawnAsync(["mkfifo", started, go]);
  pr.env.HEDGE_REVIEW_ARBITER = `cat >/dev/null; if mkdir "${pr.home}/first" 2>/dev/null; then echo > "${started}"; read line < "${go}"; fi; echo CONTINUE`;
  const earlier = join(pr.pullRequest, "reviews", "2", "round.json");
  const saved = readFileSync(earlier, "utf8");

  const slow = pr.hedge("review-start", "--scope", "fixes", "--base", fixes);
  await readFile(started, "utf8");
  rmSync(earlier);
  mkdirSync(earlier);
  await writeFile(go, "go\n");

  await expect(slow).rejects.toThrow("EISDIR");
  rmSync(earlier, { recursive: true });
  writeFileSync(earlier, saved);
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", fixes)).output).toContain(`"round":3`);
});

test("respond surfaces a reservation it cannot read instead of counting that review as unspent, and takes the known answer once the reservation reads again", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 2 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await panelReview(pr, "- feature.txt:1 | major | Correctness | the greeting drops the name | greet by name | anchor: greet");
  await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "final", "--base", panel);
  writeFileSync(join(pr.repository, "findings.md"), "- major | feature.txt:1 | the member goes unnamed | anchor: greet the member\n");
  await pr.hedge("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md");
  const reservation = join(pr.pullRequest, "reviews", "final-1", "round.json");
  const saved = readFileSync(reservation, "utf8");
  rmSync(reservation);
  mkdirSync(reservation);
  writeFileSync(join(pr.repository, "responses.md"), [1, 2, 3].map((finding) => `${finding}. known: listed under Known issues.\n`).join(""));

  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("EISDIR");
  rmSync(reservation, { recursive: true });
  writeFileSync(reservation, saved);
  expect((await pr.hedge("respond", "--round", "1", "responses.md")).code).toBe(0);
});

test("respond refuses a known answer while an unfinished review fills the budget, so a review that then finishes clean leaves no known answer below the ceiling", async () => {
  const pr = await checkout();
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 2 });
  const { panel } = await fixesRoundDue(pr);
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  writeFileSync(join(pr.repository, "responses.md"), [1, 2, 3].map((finding) => `${finding}. known: listed under Known issues.\n`).join(""));

  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer a finding \"known\" only once the review budget of 2 reviews is spent; 1 ran");
  await finishWith(pr, "2", "No findings.\n");
  await expect(pr.hedge("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer a finding \"known\" only once the review budget of 2 reviews is spent; 1 ran");
  expect((await pr.hedge("gate")).output).toContain("review: round 1 has unanswered findings 1, 2, 3");
});

const lensAnswer = (findings: string) => `FINDINGS:\n${findings}\nCOVERED: feature.txt\n`;
const major = (finding: string) => lensAnswer(`- feature.txt:1 | major | Correctness | ${finding} | fix it | anchor: greet`);
const minor = lensAnswer("- feature.txt:1 | minor | Design | a name reads plain | rename it | anchor: greet");

async function cannedPanel(pr: Checkout, answers: { design: string; others: string }) {
  for (const [lens, answer] of Object.entries(answers)) writeFileSync(join(pr.home, `${lens}-answer`), answer);
  pr.env.HEDGE_PROOF_REVIEWER = `prompt=$(cat); case "$prompt" in *"Lens: Design"*) cat "${pr.home}/design-answer";; *) cat "${pr.home}/others-answer";; esac`;
  await pr.hedge("review", "--lens", "correctness", "--lens", "design");
  expect((await pr.hedge("review", "--wait")).code).toBe(0);
  return pr.git("rev-parse", "HEAD");
}

async function finishWith(pr: Checkout, round: string, findings: string) {
  writeFileSync(join(pr.repository, "findings.md"), findings);
  await pr.hedge("review-finish", "--round", round, "--reviewer", "gpt-6.1-sol", "findings.md");
}

async function answerKnown(pr: Checkout, round: string, ...findings: number[]) {
  writeFileSync(join(pr.repository, "responses.md"), findings.map((finding) => `${finding}. known: listed under Known issues.\n`).join(""));
  return pr.hedge("respond", "--round", round, "responses.md");
}

const spentOf = (ceiling: number, ran: number) => `Answer a finding "known" only once the review budget of ${ceiling} reviews is spent; ${ran} ran`;

async function atCeiling(pr: Checkout) {
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 2 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: major("the greeting drops the name") });
  const fix = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  await finishWith(pr, "2", major("the member goes unnamed"));
  return { panel, fix };
}

test("a finished review with no blocker or major spends no review budget, while a finding without a severity does", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 2 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: lensAnswer("(none)") });
  const second = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "final", "--base", panel);
  await finishWith(pr, "final-1", "No findings.\n");
  const third = await pr.commit("feature.txt", "greet the new member\n");

  await expect(answerKnown(pr, "1", 1)).rejects.toThrow(spentOf(2, 0));
  expect((await pr.hedge("review-start", "--scope", "final", "--base", second)).output).toContain(`"id":"final-2"`);
  await finishWith(pr, "final-2", "The greeting drops the name.\n");
  await pr.commit("feature.txt", "greet every member\n");
  await expect(answerKnown(pr, "final-2", 1)).rejects.toThrow(spentOf(2, 1));
  expect((await pr.hedge("review-start", "--scope", "final", "--base", third)).output).toContain(`"id":"final-3"`);
  await finishWith(pr, "final-3", major("the greeting drops the name"));
  expect((await answerKnown(pr, "final-3", 1)).code).toBe(0);
});

test("every TESTS item needs an answer and spends review budget whatever words it starts with, while a nit finding above TESTS needs none", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 4 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  let base = await cannedPanel(pr, { design: minor, others: lensAnswer("(none)") });
  const testsItems = [
    "Nit: feature.test.ts:3 asserts the call count of greet",
    "minor, feature.test.ts:4 asserts the hardcoded output",
    "Severity | minor | open | feature.test.ts:5 mocks the greeting it checks",
    "feature.test.ts:6 reads a private field of the greeter",
  ];
  for (const [index, item] of testsItems.entries()) {
    const read = `final-${index + 1}`;
    await pr.commit("feature.txt", `greet member ${index + 2}\n`);
    expect((await pr.hedge("review-start", "--scope", "final", "--base", base)).output).toContain(`"id":"${read}"`);
    await finishWith(pr, read, `- nit: feature.txt:1 the greeting could be warmer\n\nTESTS:\n\n- ${item}\n`);
    if (index < testsItems.length - 1) await expect(answerKnown(pr, read, 2)).rejects.toThrow(spentOf(4, index + 1));
    base = await pr.git("rev-parse", "HEAD");
  }
  await pr.commit("feature.txt", "greet every member\n");

  const gate = (await pr.hedge("gate")).output;
  for (const read of ["1", "2", "3", "4"]) expect(gate).toContain(`review: final read ${read} has unanswered findings 2;`);
  expect((await answerKnown(pr, "final-4", 2)).code).toBe(0);
});

async function fixesRoundWith(findings: string) {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 1 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: lensAnswer("(none)") });
  await pr.commit("feature.txt", "greet the member\n");
  expect((await pr.hedge("review-start", "--scope", "final", "--base", panel)).output).toContain(`"id":"final-1"`);
  await finishWith(pr, "final-1", findings);
  await pr.commit("feature.txt", "greet every member\n");
  return pr;
}

test("a line that starts with TESTS opens a TESTS block as it did before, so a nit below a prose TESTS line needs an answer and spends review budget", async () => {
  const pr = await fixesRoundWith("TESTS pass under Bun.\n\n- nit: feature.txt:1 the greeting could be warmer\n");

  expect((await pr.hedge("gate")).output).toContain("review: final read 1 has unanswered findings 1;");
  expect((await answerKnown(pr, "final-1", 1)).code).toBe(0);
});

test("a review with a prose TESTS line and then No findings. needs no answer and spends no review budget", async () => {
  const pr = await fixesRoundWith("TESTS pass under Bun.\n\nNo findings.\n");

  expect((await pr.hedge("gate")).output).not.toContain("has unanswered findings");
  await expect(answerKnown(pr, "1", 1)).rejects.toThrow(spentOf(1, 0));
});

test("a saved answer to a major below a prose TESTS line stays on the major when the review ends with an Anchor check note", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "new\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await pr.hedge("review-start", "--scope", "full");
  const majorFinding = "- major | feature.txt:1 | the greeting drops the name | anchor: greet";
  const findings = ["TESTS pass under Bun.", majorFinding, ...anchorCheck(["- 1 finding quotes no anchor."])].join("\n");
  await finishWith(pr, "1", findings);
  const saved = "2. fixed in 1a2b3c4: the greeting names the member.\n";
  writeFileSync(join(pr.pullRequest, "reviews/1/responses.md"), saved);

  expect(answeredFindings(findings, saved).findings.map(({ text, answer }) => [text, answer?.text])).toEqual([["- 1 finding quotes no anchor.", undefined], [majorFinding, saved.trim()]]);
  expect((await pr.hedge("gate")).output).not.toContain("unanswered findings");
});

test("a panel lens's TESTS item after its COVERED list needs an answer though it starts with nit, while the lens's nit finding needs none", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await cannedPanel(pr, { design: `${lensAnswer("- feature.txt:1 | nit | Design | a name reads plain | rename it | anchor: greet")}TESTS:\n- nit: feature.test.ts:3 asserts the call count of greet | rewrite\n`, others: lensAnswer("(none)") });

  expect((await pr.hedge("gate")).output).toContain("review: round 1 has unanswered findings 2;");
});

test("a panel lens's TESTS items under a ## TESTS: ## heading need an answer and spend review budget", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 1 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  await cannedPanel(pr, { design: `${lensAnswer("- feature.txt:1 | nit | Design | a name reads plain | rename it | anchor: greet")}## TESTS: ##\n- nit: feature.test.ts:3 asserts the call count of greet | rewrite\n`, others: lensAnswer("(none)") });
  await pr.commit("feature.txt", "greet the member\n");

  expect((await pr.hedge("gate")).output).toContain("review: round 1 has unanswered findings 2;");
  expect((await answerKnown(pr, "1", 2)).code).toBe(0);
});

test("a review that lists only minor or nit items that lead with the severity and a comma or colon needs no answer and spends no review budget, while a minor that may be a major still does", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 1 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: lensAnswer("(none)") });
  const fix = await pr.commit("feature.txt", "greet the member\n");
  expect((await pr.hedge("review-start", "--scope", "final", "--base", panel)).output).toContain(`"id":"final-1"`);
  await finishWith(pr, "final-1", "# GPT-6.1 Sol final read 1\n\n1. minor, feature.txt:1: the word reads oddly.\n2. **nit**, feature.txt:1: the name could be shorter.\n3. nit: feature.test.ts:3 has no case for an empty name.\n4. **Minor:** feature.txt:1 the greeting could be warmer.\n5. nit: feature.ts:2 Use a clearer type name | anchor: type Greeting = string | undefined\n");
  await pr.commit("feature.txt", "greet every member\n");

  expect((await pr.hedge("gate")).output).not.toContain("has unanswered findings");
  await expect(answerKnown(pr, "final-1", 1)).rejects.toThrow(spentOf(1, 0));
  expect((await pr.hedge("review-start", "--scope", "final", "--base", fix)).output).toContain(`"id":"final-2"`);
  await finishWith(pr, "final-2", "- feature.txt:1 | minor (major if two members share a name) | the greeting drops the name\n- minor:42 | blocker | the build breaks on an empty name\n- minor: helpers.ts:42 | blocker | the helper throws on an empty name\n\nTESTS:\n\n- feature.test.ts:4 asserts the hardcoded output Severity | minor\n");
  await pr.commit("feature.txt", "greet each member\n");
  expect((await pr.hedge("gate")).output).toContain("review: final read 2 has unanswered findings 1, 2, 3, 4;");
  expect((await answerKnown(pr, "final-2", 1, 2, 3, 4)).code).toBe(0);
});

test.skipIf(process.getuid?.() === 0)("a findings file that cannot be read stops the next review with the read error, instead of counting its review as unfinished", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 1 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: lensAnswer("(none)") });
  const fix = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "final", "--base", panel);
  await finishWith(pr, "final-1", "No findings.\n");
  await pr.commit("feature.txt", "greet every member\n");
  const findings = join(pr.pullRequest, "reviews", "final-1", "findings.md");
  chmodSync(findings, 0o000);

  await expect(pr.hedge("review-start", "--scope", "final", "--base", fix)).rejects.toThrow(`EACCES: permission denied, open '${findings}'`);
  chmodSync(findings, 0o600);
  expect((await pr.hedge("review-start", "--scope", "final", "--base", fix)).output).toContain(`"id":"final-2"`);
});

test("for a panel that mixes a prose-only lens with a lens that lists a minor, the review budget spends exactly when the gate asks for an answer", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 1 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: lensAnswer("The greeting drops the name."), others: minor });
  await pr.commit("feature.txt", "greet the member\n");

  expect((await pr.hedge("gate")).output).not.toContain("has unanswered findings");
  await expect(answerKnown(pr, "1", 1)).rejects.toThrow(spentOf(1, 0));
  expect((await pr.hedge("review-start", "--scope", "final", "--base", panel)).output).toContain(`"id":"final-1"`);
  await finishWith(pr, "final-1", lensAnswer("The member goes unnamed."));
  await pr.commit("feature.txt", "greet every member\n");

  expect((await pr.hedge("gate")).output).toContain("review: final read 1 has unanswered findings 1;");
  expect((await answerKnown(pr, "final-1", 1)).code).toBe(0);
});

test("the ceiling never refuses a final read of a HEAD the gate does not carry, while a final read's major spends the last review and stops the fixes round after it", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 2 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: major("the greeting drops the name") });
  const fix = await pr.commit("feature.txt", "greet the member\n");

  expect((await pr.hedge("review-start", "--scope", "final", "--base", panel)).output).toContain(`"round":"final"`);
  await finishWith(pr, "final-1", major("the member goes unnamed"));
  await pr.commit("feature.txt", "greet every member\n");
  await expect(pr.hedge("review-start", "--scope", "fixes", "--base", panel)).rejects.toThrow("The review budget of 2 reviews is spent");
  expect((await pr.hedge("review-start", "--scope", "final", "--base", fix)).output).toContain(`"round":"final"`);
  await finishWith(pr, "final-2", "No findings.\n");

  await pr.commit("feature.test.ts", "test(\"greets every member\", () => {});\n");
  expect((await pr.hedge("gate")).output).toContain("test-only delta");
  await expect(pr.hedge("review-start", "--scope", "final", "--base", await pr.git("rev-parse", "HEAD~1"), "--agent", "One more read checks the test.")).rejects.toThrow("The review budget of 2 reviews is spent");
});

test("a HEAD that the gate carries across a revert of the latest reviewed fix has nothing to read, with or without --agent, and offers no retry, while a --base that is not the latest reviewed commit is refused first", async () => {
  const pr = await checkout();
  const { panel, fix } = await atCeiling(pr);
  await pr.git("revert", "--no-edit", fix);

  expect((await pr.hedge("gate")).output).toContain(`review: final read carried from ${panel.slice(0, 7)}: revert of a PR commit`);
  const refused = await pr.hedge("review-start", "--scope", "final", "--base", fix).then(() => "", (error: Error) => error.message);
  expect(refused).toBe(`HEAD needs no final read: the commits since ${panel.slice(0, 7)} change no file of the PR, so the read would see nothing. hedge proof gate counts the carry: final read carried from ${panel.slice(0, 7)}: revert of a PR commit`);
  await expect(pr.hedge("review-start", "--scope", "final", "--base", panel)).rejects.toThrow(`Final read base must be the latest reviewed commit ${fix}`);
  await expect(pr.hedge("review-start", "--scope", "final", "--base", fix, "--agent", "The revert needs a read.")).rejects.toThrow(`HEAD needs no final read: the commits since ${panel.slice(0, 7)} change no file of the PR, so the read would see nothing. hedge proof gate counts the carry: final read carried from ${panel.slice(0, 7)}: revert of a PR commit`);
});

test("with as many finished rounds as the ceiling but budget left by a clean panel, a HEAD the gate carries across a test-only commit gets its needs-no-final-read answer with the --agent and --override retry advice", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 2 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: minor });
  const fix = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "final", "--base", panel);
  await finishWith(pr, "final-1", major("the member goes unnamed"));
  await pr.commit("feature.test.ts", "expect(greet(\"a\")).toBe(\"hi a\");\n");

  const refused = await pr.hedge("review-start", "--scope", "final", "--base", fix).then(() => "", (error: Error) => error.message);
  expect(refused).toContain(`HEAD needs no final read: final read carried from ${fix.slice(0, 7)}: test-only delta. hedge proof gate counts the carry. To read it anyway, pass --agent '<your reason>', or the user's --override`);
});

test("a final read whose round.json is gone while its directory stays leaves the needs-no-final-read answer for a HEAD carried across a revert and a test-only commit, with the --agent and --override retry advice", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 10 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: major("the greeting drops the name") });
  const fix = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  await finishWith(pr, "2", major("the member goes unnamed"));
  const change = await pr.commit("feature.txt", "greet the new member\n");
  const reserved = JSON.parse((await pr.hedge("review-start", "--scope", "final", "--base", fix)).output.split("\n")[0]!);
  expect(reserved).toMatchObject({ round: "final", id: "final-1" });
  rmSync(join(reserved.directory, "round.json"));
  await pr.git("revert", "--no-edit", change);
  await pr.commit("feature.test.ts", "expect(greet(\"a\")).toBe(\"hi a\");\n");

  const refused = await pr.hedge("review-start", "--scope", "final", "--base", fix).then(() => "", (error: Error) => error.message);
  expect(refused).toBe(`HEAD needs no final read: final read carried from ${fix.slice(0, 7)}: test-only delta and revert of a PR commit. hedge proof gate counts the carry. To read it anyway, pass --agent '<your reason>', or the user's --override`);
});

test("a final read skips a slot whose directory lost its round.json but keeps its lock, and takes the next one", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 10 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: major("the greeting drops the name") });
  const fix = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  await finishWith(pr, "2", major("the member goes unnamed"));
  await pr.commit("feature.txt", "greet the new member\n");
  const blocked = join(pr.pullRequest, "reviews", "final-1");
  mkdirSync(blocked);
  writeFileSync(join(blocked, "round.lock"), "");

  expect((await pr.hedge("review-start", "--scope", "final", "--base", fix)).output).toContain(`"id":"final-2"`);
});

test("a fixes round left unfinished and then reverted still gets the needs-no-final-read answer, without retry advice that the unfinished review would refuse", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 10, "pull-requests.reviewCeiling": 10 });
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  const panel = await cannedPanel(pr, { design: minor, others: major("the greeting drops the name") });
  const fix = await pr.commit("feature.txt", "greet the member\n");
  await pr.hedge("review-start", "--scope", "fixes", "--base", panel);
  await finishWith(pr, "2", major("the member goes unnamed"));
  const change = await pr.commit("feature.txt", "greet the new member\n");
  expect((await pr.hedge("review-start", "--scope", "fixes", "--base", fix)).output).toContain(`"round":3`);
  await pr.git("revert", "--no-edit", change);

  const refused = await pr.hedge("review-start", "--scope", "final", "--base", fix).then(() => "", (error: Error) => error.message);
  expect(refused).toContain(`HEAD needs no final read: final read carried from ${fix.slice(0, 7)}: revert of a PR commit. hedge proof gate counts the carry.`);
  expect(refused).not.toContain("--agent");
  expect(refused).not.toContain("--override");
});

async function merge21BaseCommits(pr: Checkout, fix: string) {
  const merges = await spawnAsync(["sh", "-ec", `git checkout -q main
for i in $(seq 21); do echo "$i" > base.txt; git add base.txt; git commit -qm "Base $i"; done
git update-ref refs/remotes/origin/main HEAD
git checkout -q feature
for i in $(seq 20 -1 0); do git merge -q --no-edit "main~$i"; done`], { cwd: pr.repository, env: pr.env });
  expect(merges.exitCode).toBe(0);
  const first = await pr.git("rev-parse", "HEAD~20");
  expect(await pr.git("rev-parse", `${first}^1`)).toBe(fix);
  return first;
}

test("the ceiling lets a final read run when the gate does not carry HEAD across 21 clean base merges, though --base names the first merge", async () => {
  const pr = await checkout();
  const { fix } = await atCeiling(pr);
  const first = await merge21BaseCommits(pr, fix);

  expect((await pr.hedge("gate")).output).toContain(`review: HEAD not reviewed, last review covered ${fix.slice(0, 7)}`);
  expect((await pr.hedge("review-start", "--scope", "final", "--base", first)).output).toContain(`"round":"final"`);
});

test("a test-only commit after 21 clean base merges gets its final read without --agent, since the gate does not carry HEAD", async () => {
  const pr = await checkout();
  const { fix } = await atCeiling(pr);
  const first = await merge21BaseCommits(pr, fix);
  await pr.commit("feature.test.ts", "test(\"greets the member\", () => {});\n");

  expect((await pr.hedge("gate")).output).toContain(`review: HEAD not reviewed, last review covered ${fix.slice(0, 7)}`);
  expect((await pr.hedge("review-start", "--scope", "final", "--base", first)).output).toContain(`"round":"final"`);
});

test("a git warning about an attribute name keeps a small diff on the Read tier, since the tier counts what git printed", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "low") });
  writeFileSync(join(pr.repository, ".gitattributes"), "*.md bad^name\n");
  await pr.git("add", ".gitattributes");
  await pr.commit("README.md", "Greets new members.\n");
  await pr.hedge("require", "--none", "--reason", "fixture");
  fakeModel(pr, "REVIEWER", "FINDINGS:\nCOVERED: README.md\n");

  expect((await pr.hedge("review")).output).toContain("review tier: read: merge-risk grade low, 1 authored production lines");
});
