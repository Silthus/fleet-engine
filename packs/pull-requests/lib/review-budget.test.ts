import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnAsync } from "../../../src/testing/spawn.ts";
import { checkout, cleanFixtures, fakeModel, finishRound, graded, markPanel, reviewHead, settings } from "./proof-testing.ts";

afterEach(cleanFixtures);

const continueArbiter = (record = "/dev/null") => `cat > "${record}"; echo CONTINUE`;

test("minor and nit findings need no answer, while a blocker, a major, a finding without severity, or a TESTS item does, and the arbiter reads only blockers and majors", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  const panel = await pr.commit("feature.txt", "new\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  await pr.fleet("review-start", "--scope", "full");
  writeFileSync(join(pr.repository, "findings.md"), [
    "## Correctness",
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
  await pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md");
  markPanel(pr, "1");

  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(1);
  expect(gate.output).toContain("review: round 1 has unanswered findings 1, 4, 5;");
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in 1a2b3c4: the greeting names the member.\n");
  await expect(pr.fleet("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer findings 4, 5 too");
  const testsFixed = "5. fixed in 2b3c4d5: the test asserts the greeting.\n";
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in 1a2b3c4: the greeting names the member.\n4. known: listed under Known issues.\n" + testsFixed);
  await expect(pr.fleet("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer a finding \"known\" only once the review budget of 6 reviews is spent; 1 ran");
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in 1a2b3c4: the greeting names the member.\n4. rejected: the greeting is the fixture's.\n" + testsFixed);
  expect((await pr.fleet("respond", "--round", "1", "responses.md")).code).toBe(0);
  expect((await pr.fleet("gate")).code).toBe(0);

  const fixes = await pr.commit("feature.txt", "new member\n");
  await pr.fleet("review-start", "--scope", "fixes", "--base", panel);
  await finishRound(pr, "2");
  await pr.commit("feature.txt", "new members\n");
  const arbiter = join(pr.home, "arbiter-prompt.txt");
  pr.env.FLEET_REVIEW_ARBITER = continueArbiter(arbiter);
  expect((await pr.fleet("review-start", "--scope", "final", "--base", fixes)).code).toBe(0);
  const prompt = readFileSync(arbiter, "utf8");
  expect(prompt).toContain("the greeting drops the name");
  expect(prompt).toContain("the greeting has no severity");
  expect(prompt).not.toContain("a helper could go");
  expect(prompt).not.toContain("the word reads oddly");
  expect(prompt).not.toContain("asserts the call count");
});

test("a blocker in the Known issues section of the PR body holds the merge, and a major there does not", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "docs only");

  pr.pullRequestState({ body: "Greets new members.\n\n## Known issues\n\n- major: feature.txt:1 the greeting is plain\n" });
  expect((await pr.fleet("gate")).code).toBe(0);

  pr.pullRequestState({ body: "Greets new members.\n\n## Known issues (2)\n\n- major: feature.txt:1 the greeting is plain\n- blocker: feature.txt:1 the greeting drops the name\n\n## Tests\n\n- blocker: not a known issue\n" });
  const held = await pr.fleet("gate");
  expect(held.code).toBe(1);
  expect(held.output).toContain("known issues: an open blocker holds the merge: - blocker: feature.txt:1 the greeting drops the name");
  expect(JSON.parse((await pr.fleet("gate", "--json")).output)).toMatchObject({ held: "known issues: an open blocker holds the merge: - blocker: feature.txt:1 the greeting drops the name" });
});

test("a docs-only PR, or one under 50 authored lines with low merge risk, gets one combined lens, one read, and no final read", async () => {
  const pr = await checkout();
  await pr.commit("README.md", "Greet new members.\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", "FINDINGS:\n(none)\nCOVERED: README.md\n");
  await expect(pr.fleet("review")).rejects.toThrow("A small PR gets one read, and it is the panel");

  const started = await pr.fleet("review", "--lens", "correctness", "--lens", "design");
  expect(JSON.parse(started.output.split("\n")[0]!).lenses).toEqual([{ name: "combined", family: expect.any(String) }]);
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  const [brief, ...others] = reviewer.prompts();
  expect(others).toEqual([]);
  expect(brief).toContain("Trace one concrete input through each new branch.");
  expect(brief).toContain("Find the code judo move.");
  const reviewed = await pr.git("rev-parse", "HEAD");

  await pr.commit("README.md", "Greet every new member.\n");
  await expect(pr.fleet("review", "--scope", "final", "--base", reviewed)).rejects.toThrow("A small PR gets one read and no final read.");
  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(0);
  expect(gate.output).toContain("review: one read of a small PR in round 1; its fixes get no final read");
});

test("at the budget a known answer settles a major the PR body lists by file:line, and a known blocker holds the merge", async () => {
  const pr = await checkout();
  await pr.commit("README.md", "Greet new members.\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  fakeModel(pr, "REVIEWER", "FINDINGS:\n- README.md:1 | blocker | Correctness | the page names no member -> members see nothing | name them | anchor: Greet new members.\n- README.md:1 | major | Correctness | the page is terse -> members skim it | expand it | anchor: Greet new members.\nCOVERED: README.md\n");
  await pr.fleet("review", "--lens", "correctness");
  await pr.fleet("review", "--wait");

  writeFileSync(join(pr.repository, "responses.md"), "1. rejected: the fixture names nobody.\n2. known: listed under Known issues.\n");
  await pr.fleet("respond", "--round", "1", "responses.md");
  const unlisted = await pr.fleet("gate");
  expect(unlisted.code).toBe(1);
  expect(unlisted.output).toContain("known issues: round 1 answers findings 2 known, but the \"## Known issues\" section of the PR body does not list their file:line");
  for (const item of ["feature.txt:1 another finding", "README.md:12 a later line", "docs/README.md:1 another file", "the page is terse"]) {
    pr.pullRequestState({ body: `Greets new members.\n\n## Known issues\n\n- major: ${item}\n` });
    expect((await pr.fleet("gate")).code).toBe(1);
  }
  pr.pullRequestState({ body: "Greets new members.\n\n## Known issues\n\n- major: README.md:1 the page is terse\n" });
  expect((await pr.fleet("gate")).code).toBe(0);

  writeFileSync(join(pr.repository, "responses.md"), "1. known: listed under Known issues.\n2. known: listed under Known issues.\n");
  await pr.fleet("respond", "--round", "1", "responses.md");
  const held = await pr.fleet("gate");
  expect(held.code).toBe(1);
  expect(held.output).toContain("known issues: round 1 answers findings 1 known, and an open blocker holds the merge");
});

test("a code PR under 50 authored lines gets the combined lens only at low merge risk", async () => {
  const lensesAt = async (grade: string) => {
    const pr = await checkout();
    pr.pullRequestState({ body: graded("non-critical", grade) });
    await pr.commit("feature.ts", "export const greet = (name: string) => `hi ${name}`;\n");
    await pr.fleet("require", "--none", "--reason", "fixture");
    fakeModel(pr, "REVIEWER", "FINDINGS:\n(none)\nCOVERED: feature.ts\n");
    const started = await pr.fleet("review", "--lens", "correctness", "--lens", "design");
    return JSON.parse(started.output.split("\n")[0]!).lenses.map(({ name }: { name: string }) => name);
  };
  expect(await lensesAt("low")).toEqual(["combined"]);
  expect(await lensesAt("medium")).toEqual(["correctness", "design"]);
});

test("an unfinished panel reruns with its own lenses after the merge risk changes", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "low") });
  await pr.commit("feature.ts", "export const greet = (name: string) => `hi ${name}`;\n");
  await pr.fleet("require", "--none", "--reason", "fixture");
  const reviewer = fakeModel(pr, "REVIEWER", "Looks fine to me.");
  await pr.fleet("review", "--lens", "correctness", "--lens", "design");
  expect((await pr.fleet("review", "--wait")).code).toBe(1);

  pr.pullRequestState({ body: graded("non-critical", "medium") });
  reviewer.answer("FINDINGS:\n(none)\nCOVERED: feature.ts\n");
  const rerun = await pr.fleet("review", "--lens", "correctness", "--lens", "design");
  expect(JSON.parse(rerun.output.split("\n")[0]!).lenses.map(({ name }: { name: string }) => name)).toEqual(["combined"]);
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
});

test("the last read reads every fix since the panel commit with the Correctness lens", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  const panel = await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "fixture");
  await reviewHead(pr);
  const fixes = await pr.commit("feature.txt", "greet the member\n");
  await pr.fleet("review-start", "--scope", "fixes", "--base", panel);
  await finishRound(pr, "2");
  const head = await pr.commit("feature.txt", "greet the new member\n");
  pr.env.FLEET_REVIEW_ARBITER = continueArbiter();
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");

  expect((await pr.fleet("review", "--scope", "final", "--base", fixes)).code).toBe(0);
  const prompt = reviewer.prompts().at(-1)!;
  expect(prompt).toContain(`Review the change ${panel}..${head}`);
  expect(prompt).toContain("This is the last read: the diff holds every fix since the panel. Read it with the Correctness lens:\n\nTrace one concrete input through each new branch.");
  expect(prompt).toContain("-greet\n+greet the new member");
});

test("the gate reports HEAD unreviewed when GitHub fails while it weighs the PR's size", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "low") });
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "fixture");
  await reviewHead(pr);
  await pr.commit("feature.txt", "greet the member\n");
  pr.whileGithubReadsPull(`printf '%s' 'echo "HTTP 502" > "$(dirname "$0")/pull-error-42"' > "$(dirname "$0")/while-reading"`);
  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(1);
  expect(gate.output).toContain("review: HEAD not reviewed");
});

test("a first final read from the panel commit reads with the Correctness lens too", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  const panel = await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "fixture");
  await reviewHead(pr);
  await pr.commit("feature.txt", "greet the member\n");
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");

  expect((await pr.fleet("review", "--scope", "final", "--base", panel)).code).toBe(0);
  expect(reviewer.prompts().at(-1)!).toContain("This is the last read: the diff holds every fix since the panel. Read it with the Correctness lens");
});

test("fleet proof miss records --introduced-by-fix on the case", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet the new member\n");
  await reviewHead(pr);

  const recorded = await pr.fleet("miss", "--source", "human", "--finding", "The fix drops the member's name", "--introduced-by-fix");
  expect(JSON.parse(recorded.output)).toMatchObject({ introducedByFix: true });
  await pr.fleet("miss", "--source", "bot", "--finding", "The greeting skips the welcome email");
  const cases = readFileSync(join(pr.home, ".local/state/fleet/proof/misses.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(cases.map((miss) => miss.introducedByFix)).toEqual([true, undefined]);
});

test("a revert of a PR commit, or a commit that only deletes test files, keeps the review, and a revert of a base commit does not", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "greet\n");
  await pr.commit("feature.test.ts", "test(\"greets\", () => {});\n");
  await pr.fleet("require", "--none", "--reason", "fixture");
  await reviewHead(pr);

  const fix = await pr.commit("feature.txt", "greet the member\n");
  expect((await pr.fleet("gate")).code).toBe(1);
  await pr.git("revert", "--no-edit", fix);
  const reverted = await pr.fleet("gate");
  expect(reverted.code).toBe(0);
  expect(reverted.output).toContain("revert of a PR commit");

  await pr.git("rm", "-q", "feature.test.ts");
  await pr.git("commit", "-q", "-m", "drop the test");
  const deleted = await pr.fleet("gate");
  expect(deleted.code).toBe(0);
  expect(deleted.output).toContain("test-only delta");

  const fixed = await pr.commit("feature.txt", "greet every member\n");
  await pr.commit("feature.test.ts", "test(\"greets every member\", () => {});\n");
  await pr.git("revert", "--no-edit", fixed);
  const apart = await pr.fleet("gate");
  expect(apart.code).toBe(0);
  expect(apart.output).toContain("revert of a PR commit and test-only delta");

  const branch = await pr.git("rev-parse", "--abbrev-ref", "HEAD");
  const before = await pr.git("rev-parse", "HEAD");
  await pr.git("checkout", "-q", "-b", "elsewhere", `${before}~1`);
  const elsewhere = await pr.commit("feature.txt", "greet\n");
  await pr.git("checkout", "-q", branch);
  await pr.git("revert", "--no-edit", elsewhere);
  expect((await pr.fleet("gate")).code).toBe(1);
  await pr.git("reset", "-q", "--hard", before);

  const again = await pr.commit("feature.txt", "greet the new member\n");
  await pr.git("update-ref", "refs/remotes/origin/main", again);
  await pr.git("revert", "--no-edit", again);
  expect((await pr.fleet("gate")).code).toBe(1);
});

test("deleting a test file that code imports needs a new review", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("policy.test.ts", "export const policy = 1;\n");
  await pr.commit("app.ts", "import { policy } from \"./policy.test.ts\";\nexport const app = policy;\n");
  await pr.fleet("require", "--none", "--reason", "fixture");
  await reviewHead(pr);
  await pr.git("rm", "-q", "policy.test.ts");
  await pr.git("commit", "-q", "-m", "drop the policy");
  expect((await pr.fleet("gate")).code).toBe(1);
});

test("a known answer waits for the budget of its own phase", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.FLEET_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 2, "pull-requests.reviewCeiling": 2 });
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "fixture");
  const panel = await reviewHead(pr);
  const read = await pr.commit("feature.txt", "greet the member\n");
  await pr.fleet("review-start", "--scope", "final", "--base", panel);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.fleet("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md");
  await pr.commit("feature.txt", "greet the new member\n");
  await pr.fleet("review-start", "--scope", "final", "--phase", "babysit", "--base", read);
  writeFileSync(join(pr.repository, "findings.md"), "- major | feature.txt:1 | the member goes unnamed | anchor: greet the new member\n");
  await pr.fleet("review-finish", "--round", "final-2", "--reviewer", "gpt-6.1-sol", "findings.md");

  writeFileSync(join(pr.repository, "responses.md"), "1. known: listed under Known issues.\n");
  await expect(pr.fleet("respond", "--round", "final-2", "responses.md")).rejects.toThrow("only once the review budget of 2 reviews is spent; 1 ran");
});

test("a revert carries only from a reviewed commit before the reverted one", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "fixture");
  const panel = await reviewHead(pr);
  const first = await pr.commit("feature.txt", "greet the member\n");
  const second = await pr.commit("feature.txt", "greet the new member\n");
  await pr.fleet("review-start", "--scope", "final", "--base", panel);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.fleet("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md");

  await pr.git("revert", "--no-edit", second);
  expect((await pr.fleet("gate")).code).toBe(1);
  await pr.git("revert", "--no-edit", first);
  const back = await pr.fleet("gate");
  expect(back.code).toBe(0);
  expect(back.output).toContain(`final read carried from ${panel.slice(0, 7)}: revert of a PR commit`);

  const fix = await pr.commit("helper.txt", "names\n");
  const later = await pr.commit("other.txt", "uses the names\n");
  pr.env.FLEET_REVIEW_ARBITER = continueArbiter();
  await pr.fleet("review-start", "--scope", "final", "--base", second);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.fleet("review-finish", "--round", "final-2", "--reviewer", "gpt-6.1-sol", "findings.md");
  expect(await pr.git("rev-parse", "HEAD")).toBe(later);
  await pr.git("revert", "--no-edit", fix);
  expect((await pr.fleet("gate")).code).toBe(1);
});

test("a review that another one overtakes while it weighs the budget backs out", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical", "medium") });
  pr.env.FLEET_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 2, "pull-requests.reviewCeiling": 3 });
  await pr.commit("feature.txt", "greet\n");
  await pr.fleet("require", "--none", "--reason", "fixture");
  const panel = await reviewHead(pr);
  await pr.commit("feature.txt", "greet the member\n");
  await pr.fleet("review-start", "--scope", "fixes", "--base", panel);
  await finishRound(pr, "2");
  const fixes = await pr.git("rev-parse", "HEAD");
  await pr.commit("feature.txt", "greet the new member\n");
  const [started, go] = ["started", "go"].map((name) => join(pr.home, name));
  await spawnAsync(["mkfifo", started, go]);
  pr.env.FLEET_REVIEW_ARBITER = `cat >/dev/null; if mkdir "${pr.home}/first" 2>/dev/null; then echo > "${started}"; read line < "${go}"; fi; echo CONTINUE`;

  const slow = pr.fleet("review-start", "--scope", "fixes", "--base", fixes);
  await readFile(started, "utf8");
  await pr.fleet("review-start", "--scope", "final", "--base", fixes);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.fleet("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md");
  await writeFile(go, "go\n");

  await expect(slow).rejects.toThrow("Review final-1 started while this one weighed the budget");
  expect(existsSync(join(pr.pullRequest, "reviews", "3"))).toBe(false);
});
