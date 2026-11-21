import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptGap, checkout, cleanFixtures, fakeModel, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

async function reviewedPr() {
  const pr = await checkout();
  await pr.commit("shared.txt", "one\nand the member's name\n");
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewed = await reviewHead(pr);
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo CONTINUE";
  return { pr, reviewed };
}

test("a final read of a HEAD that only merges the base is refused, because it would read no file of the PR, and the gate carries the read across the merge", async () => {
  const { pr, reviewed } = await reviewedPr();
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");

  const refused = await pr.hedge("review", "--scope", "final", "--base", reviewed).then(() => "", (error: Error) => error.message);

  expect(refused).toBe(`HEAD needs no final read: the commits since ${reviewed.slice(0, 7)} change no file of the PR, so the read would see nothing. hedge proof gate carries the review of ${reviewed.slice(0, 7)} across 1 clean merge(s) of the base`);
  expect(reviewer.prompts()).toEqual([]);
  expect((await pr.hedge("gate")).output).toContain(`review: HEAD carried forward from the review of ${reviewed.slice(0, 7)} across 1 clean merge(s) of the base`);
});

test("a final read after a conflicting base merge that keeps the PR's side is refused, and says the gate does not carry the review", async () => {
  const { pr, reviewed } = await reviewedPr();
  await pr.advanceBase("shared.txt", "one\nand the team's name\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  writeFileSync(join(pr.repository, "shared.txt"), "one\nand the member's name\n");
  await pr.git("add", "shared.txt");
  await pr.git("commit", "-q", "--no-edit");
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");

  const refused = await pr.hedge("review", "--scope", "final", "--base", reviewed).then(() => "", (error: Error) => error.message);

  expect(refused).toBe(`HEAD needs no final read: the commits since ${reviewed.slice(0, 7)} change no file of the PR, so the read would see nothing. hedge proof gate does not carry the review to HEAD: run a full round, which reads the whole PR`);
  expect(reviewer.prompts()).toEqual([]);
});

test("a final read of a commit that puts a PR file back to the base's text reads that change", async () => {
  const { pr, reviewed } = await reviewedPr();
  await pr.commit("shared.txt", "one\n");
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");

  expect((await pr.hedge("review", "--scope", "final", "--base", reviewed)).code).toBe(0);

  expect(reviewer.prompts().at(-1)).toContain("-and the member's name");
});

test("a final read reads a merge of the base that conflicts and drops the PR's change to the base's text", async () => {
  const { pr, reviewed } = await reviewedPr();
  await pr.advanceBase("shared.txt", "one\nand the team's name\n");
  await pr.git("merge", "-q", "--no-edit", "main");
  writeFileSync(join(pr.repository, "shared.txt"), "one\nand the team's name\n");
  await pr.git("add", "shared.txt");
  await pr.git("commit", "-q", "--no-edit");
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");

  expect((await pr.hedge("review", "--scope", "final", "--base", reviewed)).code).toBe(0);

  expect(reviewer.prompts().at(-1)).toContain("-and the member's name");
});

test("a final read reads a change the PR made inside a merge of the base that would merge cleanly", async () => {
  const { pr, reviewed } = await reviewedPr();
  await pr.advanceBase("base.md", "the base moves on\n");
  await pr.git("merge", "-q", "--no-commit", "--no-ff", "main");
  writeFileSync(join(pr.repository, "feature.txt"), "greet by name\n");
  await pr.git("add", "feature.txt");
  await pr.git("commit", "-q", "--no-edit");
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");

  expect((await pr.hedge("review", "--scope", "final", "--base", reviewed)).code).toBe(0);

  expect(reviewer.prompts().at(-1)).toContain("+greet by name");
});

async function mergeBaseRename(pr: Checkout) {
  await pr.git("checkout", "-q", "main");
  await pr.git("mv", "guide.txt", "handbook.txt");
  await pr.git("commit", "-q", "-m", "Rename the guide");
  await pr.git("update-ref", "refs/remotes/origin/main", "HEAD");
  await pr.git("checkout", "-q", "feature");
  await pr.git("merge", "-q", "--no-edit", "main");
}

async function revertedAfterBaseRename(rewritten: (guide: string) => string) {
  const pr = await checkout();
  const guide = Array.from({ length: 10 }, (_, line) => `step ${line + 1}\n`).join("");
  await pr.advanceBase("guide.txt", guide);
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("guide.txt", rewritten(guide));
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewed = await reviewHead(pr);
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo CONTINUE";
  await mergeBaseRename(pr);
  await pr.commit("handbook.txt", guide);
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");
  expect((await pr.hedge("review", "--scope", "final", "--base", reviewed)).code).toBe(0);
  return reviewer.prompts().at(-1)!;
}

test("a final read reads a commit that puts a PR file back to the base's text after the base renamed that file", async () => {
  expect(await revertedAfterBaseRename((guide) => `${guide}greet the member by name\n`)).toContain("-greet the member by name");
});

test("a final read reads the PR taking back its rewrite of a file that the base renamed", async () => {
  expect(await revertedAfterBaseRename(() => "welcome the member\nshow the rules\npoint to the help page\n")).toContain("-welcome the member");
});

test("a final read reads a PR edit made before a clean merge of a base that renamed the file", async () => {
  const pr = await checkout();
  const guide = Array.from({ length: 10 }, (_, line) => `step ${line + 1}\n`).join("");
  await pr.advanceBase("guide.txt", guide);
  await pr.git("merge", "-q", "--no-edit", "main");
  await pr.commit("feature.txt", "greet\n");
  await pr.hedge("require", "--none", "--reason", "docs only");
  const reviewed = await reviewHead(pr);
  pr.env.HEDGE_REVIEW_ARBITER = "cat >/dev/null; echo CONTINUE";
  await pr.commit("guide.txt", `${guide}greet the member by name\n`);
  await pr.commit("feature.txt", "greet by name\n");
  await mergeBaseRename(pr);
  const reviewer = fakeModel(pr, "REVIEWER", "No findings.");

  expect((await pr.hedge("review", "--scope", "final", "--base", reviewed)).code).toBe(0);

  expect(reviewer.prompts().at(-1)).toContain("+greet the member by name");
});

test("when the judge finds a standing rule's condition broken, the gate names the rule and asks for no void of a decision it is not", async () => {
  const pr = await checkout();
  const rule = "Until 2026-11-26, in example/product, accept a live-run gap that only a billable run from main can prove.";
  writeFileSync(join(pr.home, ".agents/guides/standing-rules.md"), `- \`hedge proof standing --kind live-run --until 2026-11-26 --repositories example/product --rule "${rule}"\`\n`);
  await pr.hedge("standing", "--kind", "live-run", "--until", "2026-11-26", "--repositories", "example/product", "--rule", rule);
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "live-run");
  await pr.hedge("gap", "--kind", "live-run", "--reason", "only a billable run from main proves it");
  await pr.hedge("gap", "--kind", "judge", "--reason", "The judge misreads the copy");
  pr.chooseGap("judge", "The judge misreads the copy");
  await pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "judge", "--pr", "example/product#42");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "HEAD breaks the condition of decision standing rule live-run until 2026-11-26: a free run proves it", citations: [] } }));

  const gate = await pr.hedge("gate");

  expect(gate.code).toBe(3);
  expect(gate.output).toContain("judge gap: not accepted (the judge finds the condition of standing rule live-run until 2026-11-26 broken): The judge misreads the copy. Meet the condition of standing rule live-run until 2026-11-26 that the judge names, then run hedge proof gate again");
  expect(gate.output).not.toContain("hedge decision void");
});

test("when the judge finds both a decision's and a standing rule's condition broken, the gate asks to void the decision and to meet the rule", async () => {
  const pr = await checkout();
  const rule = "Until 2026-11-26, in example/product, accept a live-run gap that only a billable run from main can prove.";
  writeFileSync(join(pr.home, ".agents/guides/standing-rules.md"), `- \`hedge proof standing --kind live-run --until 2026-11-26 --repositories example/product --rule "${rule}"\`\n`);
  await pr.hedge("standing", "--kind", "live-run", "--until", "2026-11-26", "--repositories", "example/product", "--rule", rule);
  await pr.commit("feature.txt", "greet new members\n");
  await reviewHead(pr);
  await pr.hedge("require", "--kinds", "live-run,prod-shape");
  await pr.hedge("gap", "--kind", "live-run", "--reason", "only a billable run from main proves it");
  await pr.hedge("gap", "--kind", "prod-shape", "--reason", "No production read access");
  pr.chooseGap("prod-shape", "No production read access");
  const id = /\[(d-[0-9a-f]+)\]/.exec((await acceptGap(pr, "prod-shape", "--condition", "feature.txt reads no stored rows")).output)![1]!;
  await pr.hedge("gap", "--kind", "judge", "--reason", "The judge misreads the copy");
  pr.chooseGap("judge", "The judge misreads the copy");
  await acceptGap(pr, "judge");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: `HEAD breaks the condition of decision ${id} and of standing rule live-run until 2026-11-26`, citations: [] } }));

  const gate = await pr.hedge("gate");

  expect(gate.code).toBe(3);
  expect(gate.output).toContain(`End decision ${id} with hedge decision void <id> --reason <why its condition no longer holds>, then decide or ask again. Meet the condition of standing rule live-run until 2026-11-26 that the judge names, then run hedge proof gate again`);
});
