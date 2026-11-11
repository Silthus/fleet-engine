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

test("a masked private key keeps its diff lines, so a finding anchored below it holds", async () => {
  const pr = await checkout();
  const key = [["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "), "Ab1".repeat(16), "Cd2".repeat(16), ["-----END", "RSA PRIVATE KEY-----"].join(" ")];
  await pr.commit("feature.txt", ["intro", ...key, "the greeting skips the member name"].join("\n") + "\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewer = fakeModel(pr, "REVIEWER", "1. [low] feature.txt:6 the greeting names no member | anchor: the greeting skips the member name\n");

  expect((await pr.fleet("review")).code).toBe(0);

  expect(reviewer.prompts()[0]).toContain("+intro\n+[redacted private key]\n+\n+\n+\n+the greeting skips the member name\n");
  expect(reviewer.prompts()[0]).not.toContain(key[1]);
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

test("fleet proof eval sends the reviewer the marked diff, in its prompt and in the diff file it names", async () => {
  const pr = await tokenCheckout();
  await reviewHead(pr);
  await pr.fleet("miss", "--source", "human", "--finding", "A token is committed");
  const [prompt, diffFile] = ["eval-prompt", "eval-diff"].map((name) => join(pr.home, name));
  pr.env.FLEET_PROOF_REVIEWER = `cat > "${prompt}"; cp "$(sed -n 's/^.*The full diff is in \\(.*\\); the copy below.*$/\\1/p' "${prompt}")" "${diffFile}"; echo 'feature.txt:1: a token is committed'`;
  pr.env.FLEET_PROOF_EVAL_JUDGE = "cat >/dev/null; echo 'NAMED: the review names the token'";

  await pr.fleet("eval");

  for (const seen of [readFileSync(prompt, "utf8"), readFileSync(diffFile, "utf8")]) {
    expect(seen).toContain(`+${masked}`);
    expect(seen).not.toContain(fakeToken);
  }
});
