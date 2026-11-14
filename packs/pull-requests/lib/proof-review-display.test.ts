import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewRecords } from "./proof.ts";
import { reviewDisplay } from "./proof-review-display.ts";
import { checkout, cleanFixtures } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lensFindings = `## Correctness lens, by review-model

FINDINGS:
- **high**, \`src/a.ts:1\`: A drops the row.
- **low**: the name B is unclear.
- **medium**, \`src/c.ts:3\`: C retries forever.
COVERED: src/a.ts, src/c.ts
`;

test("each answer fleet proof respond takes counts for the finding it numbers, a finding without a file included", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "greet new members\n");
  await pr.fleet("review-start", "--scope", "full");
  writeFileSync(join(pr.repository, "findings.md"), lensFindings);
  await pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md");
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in 1a2b3c4: the row is kept\n2. **rejected**: the name is the domain term\n3. fixed in 1a2b3c4: one retry\n");
  expect((await pr.fleet("respond", "--round", "1", "responses.md")).code).toBe(0);

  const [round] = reviewDisplay(await reviewRecords(pr.home, { repository: "example/product", pr: 42, commit: head }));
  expect(round!.counts).toEqual({ findings: 3, fixed: 2, rejected: 1, unknown: 0 });
  expect(round!.findings.map(({ text, answer }) => [text, answer?.verdict])).toEqual([
    ["- **high**, `src/a.ts:1`: A drops the row.", "fixed"],
    ["- **low**: the name B is unclear.", "rejected"],
    ["- **medium**, `src/c.ts:3`: C retries forever.", "fixed"],
  ]);
  expect(round!.other).toBeUndefined();
});

test("an answer that is not a numbered fixed or rejected item shows as written and counts as unknown", () => {
  const commit = "a".repeat(40);
  const rounds = reviewDisplay([
    { label: "round 1", commit, reviewer: "gpt-6.1-sol", capturedBy: "fleet", findings: lensFindings.replace("A drops the row.", "A drops the row.\n  It happens on every save."), responses: "1. fixed in 1a2b3c4: the row is kept\n\n   and a test reads it back\n  4. rejected: an indented answer past the last finding\n- 3: rejected, retries are capped upstream\n  3. fixed: a second answer to the same finding\nWill handle B later.\n  B needs a rename first.\n4. fixed: an answer past the last finding\n0. rejected: an answer before the first\n" },
    { label: "final read 1", commit, reviewer: undefined, capturedBy: "author", findings: "The whole design leaks a token.", responses: undefined },
    { label: "round 2", commit, reviewer: undefined, capturedBy: "fleet", findings: "No findings.", responses: undefined },
  ]);
  expect(rounds.map(({ label, counts }) => [label, counts])).toEqual([
    ["round 1", { findings: 3, fixed: 1, rejected: 1, unknown: 1 }],
    ["final read 1", { findings: 1, fixed: 0, rejected: 0, unknown: 1 }],
    ["round 2", { findings: 0, fixed: 0, rejected: 0, unknown: 0 }],
  ]);
  expect(rounds[0]!.findings[0]).toEqual({ text: "- **high**, `src/a.ts:1`: A drops the row.\nIt happens on every save.", answer: { verdict: "fixed", text: "1. fixed in 1a2b3c4: the row is kept\nand a test reads it back" } });
  expect(rounds[0]!.findings[1]!.answer).toBeUndefined();
  expect(rounds[0]!.findings[2]!.answer).toEqual({ verdict: "rejected", text: "- 3: rejected, retries are capped upstream" });
  expect(rounds[0]!.other).toBe("4. rejected: an indented answer past the last finding\n3. fixed: a second answer to the same finding\nWill handle B later.\nB needs a rename first.\n4. fixed: an answer past the last finding\n0. rejected: an answer before the first");
  expect(rounds[1]!.findings).toEqual([{ text: "The whole design leaks a token." }]);
});

test("an unindented line right under a finding continues it, while a line after a blank line or a heading does not", () => {
  const findings = "## Correctness lens, by review-model\n\nFINDINGS:\n- **high**, `src/a.ts:1`: A drops the row.\nIt happens on every save.\n\nA paragraph after the list.\n- **low**: the name B is unclear.\n## Design lens, by review-model\nFINDINGS:\n- **medium**: C retries forever.\nCOVERED: src/a.ts\n";
  const [round] = reviewDisplay([{ label: "round 1", commit: "a".repeat(40), reviewer: "gpt-6.1-sol", capturedBy: "fleet", findings, responses: "1. fixed: the row is kept\nand a test reads it back\n" }]);
  expect(round!.findings).toEqual([
    { text: "- **high**, `src/a.ts:1`: A drops the row.\nIt happens on every save.", answer: { verdict: "fixed", text: "1. fixed: the row is kept" } },
    { text: "- **low**: the name B is unclear." },
    { text: "- **medium**: C retries forever." },
  ]);
  expect(round!.other).toBe("and a test reads it back");
});
