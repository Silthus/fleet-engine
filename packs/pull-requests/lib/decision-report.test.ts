import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptGap, checkout, cleanFixtures, fakeModel, graded, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const idIn = (output: string) => /\[(d-[0-9a-f]+)\]/.exec(output)![1]!;

async function reportOf(pr: Checkout) {
  const report = (await pr.decide("report", "--pr", "example/product#42")).output.split("\n");
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
