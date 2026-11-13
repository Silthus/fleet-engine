import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptGap, checkout, cleanFixtures, fakeModel, fixture, graded, reviewHead, settings, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const idIn = (output: string) => /\[(d-[0-9a-f]+)\]/.exec(output)![1]!;

async function reportOf(pr: Checkout, cwd = pr.repository, ...prs: string[]) {
  const report = (await pr.decideIn(cwd, "report", ...(prs.length ? prs : ["example/product#42"]).flatMap((ref) => ["--pr", ref]))).output.split("\n");
  const section = (heading: string) => { const from = report.indexOf(heading) + 1; const to = report.findIndex((line, index) => index >= from && line.startsWith("### ")); return report.slice(from, to < 0 ? undefined : to).filter(Boolean); };
  return { stillYours: section("### Still yours"), proofs: section("### Proofs").slice(2) };
}

test("the report says a PR's proofs pass only when the gate passes with its judge at HEAD, and says when the judge has not run", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  const short = head.slice(0, 7);
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");

  expect(await reportOf(pr)).toEqual({
    stillYours: [`- example/product#42: the judge has not run at HEAD ${short} with these proofs, so they are not known to pass. Run fleet proof gate.`],
    proofs: ["| example/product#42 | none owed (Docs only) | judge: not run at HEAD | none | none yet |"],
  });

  fakeModel(pr, "JUDGE", verdict({ owed: { verdict: "fail", reason: "feature.txt is code, not docs", citations: ["feature.txt"] } }));
  const failed = await pr.fleet("gate", "--json");
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.output)).toMatchObject({ code: 1, judge: { state: "fail", model: "judge-under-test" } });
  expect(await reportOf(pr)).toEqual({ stillYours: ["None."], proofs: ["| example/product#42 | none owed (Docs only) | judge: fail | none | none yet |"] });

  await pr.fleet("gap", "--kind", "judge", "--reason", "The judge reads feature.txt as code");
  pr.pullRequestState({ body: graded("critical") });
  expect(await reportOf(pr)).toEqual({
    stillYours: ["- **Blocker:** example/product#42 is critical at HEAD and its judge gap is not accepted: The judge reads feature.txt as code."],
    proofs: ["| example/product#42 | none owed (Docs only) | judge: The judge reads feature.txt as code (not accepted) | none | none yet |"],
  });

  pr.chooseGap("judge", "The judge reads feature.txt as code");
  const accepted = idIn((await acceptGap(pr, "judge")).output);
  const passed = await pr.fleet("gate", "--json");
  expect(passed.code).toBe(0);
  expect(JSON.parse(passed.output)).toMatchObject({ code: 0, judge: { state: "fail", gap: { commit: head, reason: "The judge reads feature.txt as code", accepted: { by: "the user", mark: "👤", id: accepted } } } });
  expect(await reportOf(pr)).toEqual({
    stillYours: ["- Merge example/product#42: its proofs pass, and it waits on your merge word."],
    proofs: [`| example/product#42 | none owed (Docs only) | judge: The judge reads feature.txt as code (accepted by 👤 ${accepted}) | none | none yet |`],
  });
});

test("the report weighs a merged PR's post-deploy watch as landed", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical"), merged: true });
  const head = await reviewHead(pr);
  await pr.fleet("require", "--kinds", "post-deploy-watch");
  writeFileSync(join(pr.repository, "watch.log"), "error rate flat for 30 minutes after the deploy");
  await pr.fleet("save", "--kind", "post-deploy-watch", "watch.log");

  expect((await reportOf(pr)).proofs).toEqual([`| example/product#42 | post-deploy-watch at ${head.slice(0, 7)} | judge: not run at HEAD | none | none yet |`]);
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

test("the report reads each PR's gate outcome without a checkout, and one PR it cannot read prints as not known here", async () => {
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

  pr.env.FLEET_SETTINGS = JSON.stringify({ ...settings, "pull-requests.criticalPathFiles": "example/product=critical-paths.md" });
  expect(await reportOf(pr, elsewhere, "example/product#42", "example/other#7")).toEqual({
    stillYours: ["None."],
    proofs: [
      expect.stringMatching(/^\| example\/product#42 \| not known here: Cannot read the critical-path file .* \| none \| none \| none yet \|$/),
      "| example/other#7 | none | owed proofs: not recorded; judge: not run at HEAD | none | none yet |",
    ],
  });
});

test("the report trusts a saved gate outcome only while the judge's input is the same", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "Docs only");
  expect((await pr.fleet("gate")).code).toBe(0);
  writeFileSync(join(pr.home, ".agents/guides/coding-standards.md"), "# Coding standards\n\n- Test every branch.");

  expect(await reportOf(pr)).toEqual({
    stillYours: [`- example/product#42: the judge has not run at HEAD ${head.slice(0, 7)} with these proofs, so they are not known to pass. Run fleet proof gate.`],
    proofs: ["| example/product#42 | none owed (Docs only) | judge: not run at HEAD | none | none yet |"],
  });
});
