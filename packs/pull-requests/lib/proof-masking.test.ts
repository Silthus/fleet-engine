import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanFixtures, checkout, fakeModel, reviewHead, verdict } from "./proof-testing.ts";

afterEach(cleanFixtures);

const fakeToken = ["gh", "p_", "x1".repeat(18)].join("");
const masked = "token = [redacted GitHub token]";

async function tokenCheckout() {
  const pr = await checkout();
  await pr.commit("feature.txt", `token = ${fakeToken}\n`);
  await pr.fleet("require", "--none", "--reason", "docs only");
  return pr;
}

test("fleet proof review sends the reviewer and its diff file a marker that names the kind in place of a token-shaped value, and anchors on the marked line hold", async () => {
  const pr = await tokenCheckout();
  const reviewer = fakeModel(pr, "REVIEWER", `1. [high] feature.txt:1 a token-shaped value is committed | anchor: ${masked}\n`);

  expect((await pr.fleet("review")).code).toBe(0);

  const prompt = reviewer.prompts()[0]!;
  expect(prompt).toContain(`+${masked}`);
  expect(prompt).not.toContain(fakeToken);
  const diffFile = readFileSync(join(pr.pullRequest, "reviews/1/diff.patch"), "utf8");
  expect(diffFile).toContain(`+${masked}`);
  expect(diffFile).not.toContain(fakeToken);
  expect(existsSync(join(pr.pullRequest, "reviews/1/anchors.md"))).toBe(false);
});

test("each panel lens gets the marked diff, and lens anchors on the marked line hold", async () => {
  const pr = await tokenCheckout();
  const reviewer = fakeModel(pr, "REVIEWER", `FINDINGS:\n- feature.txt:1 | major | Security | a committed token -> a leak | drop it | sites: feature.txt:1 | anchor: ${masked}\nCOVERED: feature.txt\n`);

  await pr.fleet("review", "--lens", "correctness");
  expect((await pr.fleet("review", "--wait")).code).toBe(0);
  expect(reviewer.prompts()[0]).toContain(`+${masked}`);
  expect(reviewer.prompts()[0]).not.toContain(fakeToken);
  expect(readFileSync(join(pr.pullRequest, "reviews/1/diff.patch"), "utf8")).not.toContain(fakeToken);
  expect(existsSync(join(pr.pullRequest, "reviews/1/anchors.md"))).toBe(false);
});

test("the judge gets the marked diff", async () => {
  const pr = await tokenCheckout();
  await reviewHead(pr);
  const judge = fakeModel(pr, "JUDGE", verdict());

  expect((await pr.fleet("gate")).code).toBe(0);

  expect(judge.prompts()[0]).toContain(`+${masked}`);
  expect(judge.prompts()[0]).not.toContain(fakeToken);
});

test("fleet proof eval sends the reviewer the marked diff", async () => {
  const pr = await tokenCheckout();
  await reviewHead(pr);
  await pr.fleet("miss", "--source", "human", "--finding", "A token is committed");
  const reviewer = fakeModel(pr, "REVIEWER", "feature.txt:1: a token is committed\n");
  pr.env.FLEET_PROOF_EVAL_JUDGE = "cat >/dev/null; echo 'NAMED: the review names the token'";

  await pr.fleet("eval");

  expect(reviewer.prompts()[0]).toContain(`+${masked}`);
  expect(reviewer.prompts()[0]).not.toContain(fakeToken);
});
