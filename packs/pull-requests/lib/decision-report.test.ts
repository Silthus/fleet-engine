import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptGap, checkout, cleanFixtures, fakeModel, fixture, graded, markPanel, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const idIn = (output: string) => /\[(d-[0-9a-f]+)\]/.exec(output)![1]!;

async function reportOf(pr: Checkout, cwd = pr.repository, ...prs: string[]) {
  const report = (await pr.decideIn(cwd, "report", ...(prs.length ? prs : ["example/product#42"]).flatMap((ref) => ["--pr", ref]))).output.split("\n");
  const section = (heading: string) => { const from = report.indexOf(heading) + 1; const to = report.findIndex((line, index) => index >= from && line.startsWith("### ")); return report.slice(from, to < 0 ? undefined : to).filter(Boolean); };
  return { stillYours: section("### Still yours"), proofs: section("### Proofs").slice(2) };
}

const notGated = (short: string, landed = "") => ({
  stillYours: [`- example/product#42: the gate has not run at HEAD ${short} with these proofs, so they are not known to pass. Run fleet proof gate${landed}.`],
  proofs: [`| example/product#42 | none | gate: not run at HEAD ${short} with these proofs | none | none yet |`],
});

test("the report prints the gate's last summary at HEAD, and sends the user to the gate while no gate ran with these proofs", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  const short = head.slice(0, 7);
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");

  expect(await reportOf(pr)).toEqual(notGated(short));

  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "feature.txt is code, not docs", citations: ["feature.txt"] } }));
  const failed = await pr.fleet("gate", "--json");
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.output)).toMatchObject({ code: 1, judge: { state: "fail", model: "judge-under-test" } });
  expect(await reportOf(pr)).toEqual({ stillYours: [`- example/product#42: its proofs are not shown to pass at HEAD ${short} as read now (gate exit 1). Run fleet proof gate in its checkout to see why.`], proofs: ["| example/product#42 | none owed (Docs only) | judge: fail | none | none yet |"] });

  await pr.fleet("gap", "--kind", "judge", "--reason", "The judge reads feature.txt as code");
  pr.pullRequestState({ body: graded("critical") });
  expect(await reportOf(pr)).toEqual(notGated(short));
  expect((await pr.fleet("gate")).code).toBe(3);
  expect(await reportOf(pr)).toEqual({
    stillYours: ["- **Blocker:** example/product#42 is critical at HEAD and its judge gap is not accepted: The judge reads feature.txt as code."],
    proofs: ["| example/product#42 | none owed (Docs only) | judge: The judge reads feature.txt as code (not accepted) | none | none yet |"],
  });

  pr.chooseGap("judge", "The judge reads feature.txt as code");
  const accepted = idIn((await acceptGap(pr, "judge")).output);
  expect(await reportOf(pr)).toEqual(notGated(short));
  const passed = await pr.fleet("gate", "--json");
  expect(passed.code).toBe(0);
  expect(JSON.parse(passed.output)).toMatchObject({ code: 0, judge: { state: "fail", gap: { commit: head, reason: "The judge reads feature.txt as code", accepted: { by: "the user", mark: "👤", id: accepted } } } });
  expect(await reportOf(pr)).toEqual({
    stillYours: ["- Merge example/product#42: its proofs pass, and it waits on your merge word."],
    proofs: [`| example/product#42 | none owed (Docs only) | judge: The judge reads feature.txt as code (accepted by 👤 ${accepted}) | none | none yet |`],
  });
});

test("a closed critical PR with a gap the user has not accepted is no blocker of the user's", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "feature.txt is code, not docs", citations: ["feature.txt"] } }));
  await pr.fleet("gap", "--kind", "judge", "--reason", "The judge reads feature.txt as code");
  expect((await pr.fleet("gate")).code).toBe(3);
  expect((await reportOf(pr)).stillYours).toEqual(["- **Blocker:** example/product#42 is critical at HEAD and its judge gap is not accepted: The judge reads feature.txt as code."]);

  pr.pullRequestState({ closed: true });
  expect(await reportOf(pr)).toEqual({
    stillYours: ["None."],
    proofs: ["| example/product#42 | none owed (Docs only) | judge: The judge reads feature.txt as code (not accepted) | none | none yet |"],
  });
});

test("the report shows a merged PR's post-deploy watch once the gate weighed it as landed", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical"), merged: true });
  const head = await reviewHead(pr);
  await pr.fleet("require", "--kinds", "post-deploy-watch");
  writeFileSync(join(pr.repository, "watch.log"), "error rate flat for 30 minutes after the deploy");
  await pr.fleet("save", "--kind", "post-deploy-watch", "watch.log");

  await pr.fleet("gate");
  expect(await reportOf(pr)).toEqual(notGated(head.slice(0, 7), " --landed"));
  expect((await pr.fleet("gate", "--landed")).code).toBe(0);
  expect((await reportOf(pr)).proofs).toEqual([`| example/product#42 | post-deploy-watch at ${head.slice(0, 7)} | none | none | none yet |`]);
});

test("the report shows the gate's outcome when the judge was unavailable and the user accepted that gap, and a later gate asks the judge again", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  const judge = fakeModel(pr, "JUDGE", "not json");

  expect((await pr.fleet("gate")).output).toContain("judge: unavailable (unparseable answer: not json)");
  await pr.fleet("gap", "--kind", "judge", "--reason", "The judge is down");
  pr.chooseGap("judge", "The judge is down");
  const accepted = idIn((await acceptGap(pr, "judge")).output);
  expect((await pr.fleet("gate")).code).toBe(0);
  expect(await reportOf(pr)).toEqual({
    stillYours: ["- Merge example/product#42: its proofs pass, and it waits on your merge word."],
    proofs: [`| example/product#42 | none owed (Docs only) | judge: The judge is down (accepted by 👤 ${accepted}) | none | none yet |`],
  });

  judge.answer(verdict());
  expect(JSON.parse((await pr.fleet("gate", "--json")).output)).toMatchObject({ code: 0, judge: { state: "pass" } });
  expect((await reportOf(pr)).proofs).toEqual(["| example/product#42 | none owed (Docs only) | none | none | none yet |"]);
});

test("the report reads each PR's gate outcome without a checkout, and a PR it cannot read stays the user's", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  expect((await pr.fleet("gate")).code).toBe(0);
  const elsewhere = fixture("fleet-report-elsewhere-");

  expect(await reportOf(pr, elsewhere)).toEqual({
    stillYours: ["- Merge example/product#42: its proofs pass, and it waits on your merge word."],
    proofs: ["| example/product#42 | none owed (Docs only) | none | none | none yet |"],
  });

  pr.pullRequestState({ number: 7, unreadable: "gh: Not Found (HTTP 404)" });
  const unreadable = "gh api repos/example/other/pulls/7 failed (gh: Not Found (HTTP 404))";
  expect(await reportOf(pr, elsewhere, "example/product#42", "example/other#7")).toEqual({
    stillYours: [
      `- example/other#7: its proofs are not known here (${unreadable}). Run fleet proof gate.`,
      "- Merge example/product#42: its proofs pass, and it waits on your merge word.",
    ],
    proofs: ["| example/product#42 | none owed (Docs only) | none | none | none yet |", `| example/other#7 | not known here: ${unreadable} | none | none | none yet |`],
  });

  pr.pullRequestState({ unreadable: "gh: Not Found (HTTP 404)" });
  expect((await reportOf(pr, elsewhere, "example/other#7")).stillYours).toEqual([`- example/other#7: its proofs are not known here (${unreadable}). Run fleet proof gate.`]);
});

test("a report outside the checkout never offers the merge of a PR whose carried review it cannot check, and the checkout's report does", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.advanceBase("base.txt", "base\n");
  const head = await pr.git("merge", "-q", "--no-edit", "origin/main").then(() => pr.git("rev-parse", "HEAD"));
  await pr.fleet("require", "--none", "--reason", "Docs only");
  expect((await pr.fleet("gate")).code).toBe(0);

  expect((await reportOf(pr)).stillYours).toEqual(["- Merge example/product#42: its proofs pass, and it waits on your merge word."]);
  expect((await reportOf(pr, fixture("fleet-report-elsewhere-"))).stillYours).toEqual([`- example/product#42: its proofs are not shown to pass at HEAD ${head.trim().slice(0, 7)} as read now (gate exit 1). Run fleet proof gate in its checkout to see why.`]);
});

test("the report sends the user back to the gate after new proofs, a decision on the PR, a new tier, a new base, or a moved base", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  const short = head.slice(0, 7);
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  const merge = { stillYours: ["- Merge example/product#42: its proofs pass, and it waits on your merge word."], proofs: ["| example/product#42 | none owed (Docs only) | none | none | none yet |"] };
  expect((await pr.fleet("gate")).code).toBe(0);
  expect(await reportOf(pr)).toEqual(merge);

  writeFileSync(join(pr.repository, "run.log"), "sent 1 email, delivered");
  await pr.fleet("save", "--kind", "live-run", "run.log");
  expect(await reportOf(pr)).toEqual(notGated(short));
  expect((await pr.fleet("gate")).code).toBe(0);
  expect(await reportOf(pr)).toEqual(merge);

  await pr.decide("record", "--mark", "🤖", "--class", "design", "--pr", "example/other#5", "--question", "Another PR's choice?", "--answer", "Theirs", "--rejected", "Ours", "--reason", "Not this PR");
  expect(await reportOf(pr)).toEqual(merge);
  await pr.decide("record", "--mark", "🤖", "--class", "design", "--pr", "example/product#42", "--question", "Where does the parser go?", "--answer", "A new module", "--rejected", "The shared parser", "--reason", "Smaller diff");
  expect(await reportOf(pr)).toEqual(notGated(short));
  expect((await pr.fleet("gate")).code).toBe(0);
  expect(await reportOf(pr)).toEqual(merge);

  pr.pullRequestState({ body: graded("critical") });
  expect(await reportOf(pr)).toEqual(notGated(short));
  expect((await pr.fleet("gate")).code).toBe(0);
  expect(await reportOf(pr)).toEqual(merge);

  await pr.git("update-ref", "refs/remotes/origin/release", "refs/remotes/origin/main");
  pr.pullRequestState({ base: "release" });
  expect(await reportOf(pr)).toEqual(notGated(short));
  expect((await pr.fleet("gate")).code).toBe(0);
  expect(await reportOf(pr)).toEqual(merge);

  await pr.advanceBase("base.txt", "base\n");
  expect(await reportOf(pr)).toEqual(notGated(short));
});

test("the report stops offering the merge once a check fails after a passing gate", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  pr.ci([{ name: "test", bucket: "pass" }]);
  expect((await pr.fleet("gate")).code).toBe(0);
  expect((await reportOf(pr)).stillYours).toEqual(["- Merge example/product#42: its proofs pass, and it waits on your merge word."]);

  pr.ci([{ name: "test", bucket: "fail" }]);
  expect((await reportOf(pr)).stillYours).toEqual([`- example/product#42: its proofs are not shown to pass at HEAD ${head.slice(0, 7)} as read now (gate exit 1). Run fleet proof gate in its checkout to see why.`]);
});

test("the report stops offering the merge of a merged PR once a check fails after its landed gate", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical"), merged: true });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  expect((await pr.fleet("gate", "--landed")).code).toBe(0);
  expect((await reportOf(pr)).stillYours).toEqual(["None."]);

  pr.ci([{ name: "test", bucket: "fail" }]);
  expect((await reportOf(pr)).stillYours).toEqual([`- example/product#42: its proofs are not shown to pass at HEAD ${head.slice(0, 7)} as read now (gate exit 1). Run fleet proof gate --landed in its checkout to see why.`]);
});

test("the report never offers the merge when GitHub moves the PR to a new head while the report reads it", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  expect((await pr.fleet("gate")).code).toBe(0);
  const pushed = await pr.commit("feature.txt", "greet all new members\n");
  pr.githubHead(head);
  expect((await reportOf(pr)).stillYours).toEqual(["- Merge example/product#42: its proofs pass, and it waits on your merge word."]);

  pr.whileGithubReadsPull(`printf '%s' ${pushed} > "$(dirname "$0")/next-head"`);
  expect((await reportOf(pr)).stillYours).toEqual([`- example/product#42: its proofs are not shown to pass at HEAD ${head.slice(0, 7)} as read now (gate exit 1). Run fleet proof gate in its checkout to see why.`]);
});

test("the report never offers the merge when GitHub moves the PR to a new base while the report reads it", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  expect((await pr.fleet("gate")).code).toBe(0);
  expect((await reportOf(pr)).stillYours).toEqual(["- Merge example/product#42: its proofs pass, and it waits on your merge word."]);

  const movedBase = await pr.git("commit-tree", "main^{tree}", "-p", "main", "-m", "Change the base");
  pr.whileGithubReadsPull(`printf '%s' ${movedBase} > "$(dirname "$0")/base-sha"`);
  expect((await reportOf(pr)).stillYours).toEqual([`- example/product#42: its proofs are not shown to pass at HEAD ${head.slice(0, 7)} as read now (gate exit 1). Run fleet proof gate in its checkout to see why.`]);
});

test("the report keeps the judge's verdict through a body edit outside the merge-risk callout, and drops it when the callout changes", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  expect((await pr.fleet("gate")).code).toBe(0);

  pr.pullRequestState({ body: `${graded("non-critical")}\n## How did you test this code?\n\nThe receipt lists each proof.\n` });
  expect((await reportOf(pr)).stillYours).toEqual(["- Merge example/product#42: its proofs pass, and it waits on your merge word."]);

  pr.pullRequestState({ body: graded("non-critical").replace("🔵 **Merge risk: low** · two-way door", "🔴 **Merge risk: high** · one-way door") });
  expect(await reportOf(pr)).toEqual(notGated(head.slice(0, 7)));
});

test("the report never offers the merge on an accepted gap whose condition the judge has not weighed", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  await pr.fleet("gap", "--kind", "ci", "--reason", "Fork CI cannot create its GitHub App token");
  pr.chooseGap("ci", "Fork CI cannot create its GitHub App token");
  await acceptGap(pr, "ci", "--condition", "No check at HEAD has failed");
  expect((await pr.fleet("gate")).code).toBe(0);
  expect((await reportOf(pr)).stillYours).toEqual(["- Merge example/product#42: its proofs pass, and it waits on your merge word."]);

  pr.ci([{ name: "test", bucket: "fail" }]);
  expect((await reportOf(pr)).stillYours).toEqual([`- example/product#42: its proofs are not shown to pass at HEAD ${head.slice(0, 7)} as read now (gate exit 1). Run fleet proof gate in its checkout to see why.`]);
});

test("the report never offers the merge once a check fails after the judge weighed an accepted gap's condition", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  pr.ci("none");
  await pr.fleet("gap", "--kind", "ci", "--reason", "Fork CI cannot create its GitHub App token");
  pr.chooseGap("ci", "Fork CI cannot create its GitHub App token");
  await acceptGap(pr, "ci", "--condition", "No check at HEAD has failed");
  expect((await pr.fleet("gate")).code).toBe(0);
  expect((await reportOf(pr)).stillYours).toEqual(["- Merge example/product#42: its proofs pass, and it waits on your merge word."]);

  pr.ci([{ name: "test", bucket: "fail" }]);
  expect((await reportOf(pr)).stillYours).toEqual([`- example/product#42: its proofs are not shown to pass at HEAD ${head.slice(0, 7)} as read now (gate exit 1). Run fleet proof gate in its checkout to see why.`]);
});

test("the report never offers the merge once an optional check fails after the judge weighed an accepted gap's condition", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--kinds", "prod-shape");
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access");
  pr.chooseGap("prod-shape", "No production read access");
  await acceptGap(pr, "prod-shape", "--condition", "No check at HEAD has failed");
  pr.required("main", [{ context: "test" }]);
  pr.ci([{ name: "test", bucket: "pass" }, { name: "lint", bucket: "pass" }]);
  expect((await pr.fleet("gate")).code).toBe(0);
  expect((await reportOf(pr)).stillYours).toEqual(["- Merge example/product#42: its proofs pass, and it waits on your merge word."]);

  pr.ci([{ name: "test", bucket: "pass" }, { name: "lint", bucket: "fail" }]);
  expect((await reportOf(pr)).stillYours).toEqual([`- example/product#42: its proofs are not shown to pass at HEAD ${head.slice(0, 7)} as read now (gate exit 1). Run fleet proof gate in its checkout to see why.`]);
});

test("the report never offers the merge once another passing check takes the place of the one an accepted gap's condition names, nor after the gate runs again", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  const broken = verdict({ proof: { verdict: "fail", reason: "The test check the condition names no longer runs at HEAD", citations: ["ci"] } });
  pr.env.FLEET_PROOF_JUDGE = `if grep -q 'test (app 1): pass'; then echo '${verdict()}'; else echo '${broken}'; fi`;
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--kinds", "prod-shape");
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access");
  pr.chooseGap("prod-shape", "No production read access");
  await acceptGap(pr, "prod-shape", "--condition", "The test check passes at HEAD");
  pr.ci([{ name: "test", bucket: "pass" }]);
  expect((await pr.fleet("gate")).code).toBe(0);
  expect((await reportOf(pr)).stillYours).toEqual(["- Merge example/product#42: its proofs pass, and it waits on your merge word."]);

  pr.ci([{ name: "lint", bucket: "pass" }]);
  const refused = [`- example/product#42: its proofs are not shown to pass at HEAD ${head.slice(0, 7)} as read now (gate exit 1). Run fleet proof gate in its checkout to see why.`];
  expect((await reportOf(pr)).stillYours).toEqual(refused);
  expect((await pr.fleet("gate")).code).toBe(1);
  expect((await reportOf(pr)).stillYours).toEqual(refused);
});

test("the report keeps the gate of HEAD when a gate of an older commit finishes later", async () => {
  const pr = await checkout();
  const older = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  await pr.commit("feature.txt", "greet all new members\n");
  expect((await pr.fleet("review-start", "--scope", "fixes", "--base", older)).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.fleet("review-finish", "--round", "2", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  markPanel(pr, "2");
  expect((await pr.fleet("gate")).code).toBe(0);

  pr.githubHead(older);
  expect((await pr.fleet("gate", "--commit", older)).code).toBe(0);
  pr.githubHead(undefined);

  expect((await reportOf(pr)).stillYours).toEqual(["- Merge example/product#42: its proofs pass, and it waits on your merge word."]);
});
