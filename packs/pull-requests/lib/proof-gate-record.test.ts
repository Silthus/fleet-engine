import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { gateRecordPath, readJson } from "./proof.ts";
import { checkout, cleanFixtures, reviewHead, verdict, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const recordAt = (pr: Checkout, commit: string) => readJson<unknown>(gateRecordPath(pr.home, { repository: "example/product", pr: 42, commit }), undefined);

async function reviewed() {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "new\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  return { pr, head };
}

test("a passing gate records exit 0 for the commit it judged", async () => {
  const { pr, head } = await reviewed();
  await reviewHead(pr);
  expect((await pr.fleet("gate")).code).toBe(0);
  expect(await recordAt(pr, head)).toEqual({ code: 0, reason: "pass" });
});

test("a mechanical failure records the check that held the gate, not the green CI line printed last", async () => {
  const { pr, head } = await reviewed();
  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(1);
  expect(gate.output.split("\n").filter((line) => !line.startsWith("gate: ")).at(-1)).toStartWith("ci: green");
  expect(await recordAt(pr, head)).toEqual({ code: 1, reason: expect.stringMatching(/^review: no finished panel round on the PR\. /) });
});

test("a judge failure records the question the judge failed", async () => {
  const { pr, head } = await reviewed();
  await reviewHead(pr);
  pr.env.FLEET_PROOF_JUDGE = `cat >/dev/null; echo '${verdict({ proof: { verdict: "fail", reason: "No evidence shows the greeting", citations: [] } })}'`;
  expect((await pr.fleet("gate")).code).toBe(1);
  expect(await recordAt(pr, head)).toEqual({ code: 1, reason: "judge proof: fail: No evidence shows the greeting" });
});

test("a gate run that throws replaces an earlier pass with exit 1 and the error's first line", async () => {
  const { pr, head } = await reviewed();
  await reviewHead(pr);
  expect((await pr.fleet("gate")).code).toBe(0);
  rmSync(join(pr.home, ".agents/guides/coding-standards.md"));
  await expect(pr.fleet("gate")).rejects.toThrow("coding-standards.md is missing or empty");
  expect(await recordAt(pr, head)).toEqual({ code: 1, reason: "~/.agents/guides/coding-standards.md is missing or empty; it holds the coding standards to review against" });
});
