import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, cleanFixtures, graded, ledgerDecisions, reviewHead } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lineOf = (output: string, start: string) => output.split("\n").find((line) => line.startsWith(start));
const idIn = (output: string) => /\[(d-[0-9a-f]+)\]/.exec(output)![1]!;

test("a gap reason recorded again after the user's acceptance leaves the gap accepted (2026-11-12)", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.fleet("require", "--kinds", "prod-shape");
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access");
  pr.choose("Accept the gap", "Accept the prod-shape gap? example/product#42: No production read access");
  const recorded = await pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "prod-shape", "--pr", "example/product#42");
  expect(recorded.code).toBe(0);
  const id = idIn(recorded.output);

  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "Still no production read access, reworded");
  const gate = await pr.fleet("gate");
  const short = (await pr.git("rev-parse", "HEAD")).slice(0, 7);
  expect(lineOf(gate.output, "prod-shape:")).toBe(`prod-shape: gap from ${short}, accepted by 👤 decision ${id} (2026-10-25 "Accept the gap"): Still no production read access, reworded`);
  expect(gate.code).toBe(0);
});

test("an agent never accepts a panel gap: record refuses it, and the gate lapses one already in the ledger", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  pr.pullRequestState({ body: graded("non-critical") });
  await pr.fleet("require", "--none", "--reason", "docs only");
  await pr.fleet("review-start", "--scope", "full");
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md");
  await pr.fleet("gap", "--kind", "panel", "--reason", "A prune lane runs no QA swarm");

  await expect(pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "panel", "--pr", "example/product#42", "--question", "Accept the panel gap?", "--answer", "Accept it", "--rejected", "Ask the user", "--reason", "A prune lane")).rejects.toThrow("a panel gap is the user's to accept");
  expect(ledgerDecisions(pr)).toEqual([]);

  const forged = { id: "d-0000feed", at: "2026-10-25T12:00:00.000Z", class: "proof-gap", mark: "🤖", question: "Accept the panel gap?", answer: "Accept it", rejected: "Ask the user", reason: "A prune lane", scope: { prs: ["example/product#42"], kinds: ["panel"] }, effect: "accept", where: { thread: "thread-1", machine: "box" } };
  mkdirSync(join(pr.home, ".local/state/fleet"), { recursive: true });
  appendFileSync(join(pr.home, ".local/state/fleet/decisions.jsonl"), JSON.stringify({ type: "decide", decision: forged }) + "\n");
  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(3);
  expect(gate.output).toContain("panel gap from");
  expect(gate.output).toContain("not accepted (🤖 decision d-0000feed lapsed: a panel gap is the user's to accept): A prune lane runs no QA swarm");
  expect(lineOf(gate.output, "lapsed:")).toBe("lapsed: 🤖 decision d-0000feed no longer counts; ask the user, or decide again once the reason is gone");
});
