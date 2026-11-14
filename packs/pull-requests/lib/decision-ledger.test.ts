import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fold, type LedgerEvent } from "./decision-ledger.ts";
import { acceptGap, checkout, clean, cleanFixtures, exitedPid, fakeModel, graded, hubAt, ledgerDecisions, reviewHead, settings, type Checkout } from "./proof-testing.ts";

afterEach(cleanFixtures);

const lineOf = (output: string, start: string) => output.split("\n").find((line) => line.startsWith(start));
const idIn = (output: string) => /\[(d-[0-9a-f]+)\]/.exec(output)![1]!;
const agent = (pr: Checkout, kind: string, ...prs: string[]) => pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", kind, ...(prs.length ? prs : ["example/product#42"]).flatMap((ref) => ["--pr", ref]), "--question", `Accept the ${kind} gap?`, "--answer", "Accept it", "--rejected", "Ask the user", "--reason", "The proof cannot run here");

async function owing(pr: Checkout, kind: string, reason = "No sandbox") {
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.fleet("require", ...(kind === "ci" ? ["--none", "--reason", "docs only"] : ["--kinds", kind]));
  await pr.fleet("gap", "--kind", kind, "--reason", reason);
}

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

test("one answer whose question names three PRs accepts the gap on each of them and no fourth", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  pr.choose("Accept the gap", "Accept the prod-shape gap? example/product#42, product#43 and https://github.com/example/product/pull/44: No sandbox");
  const prs = ["example/product#42", "example/product#43", "https://github.com/example/product/pull/44"].flatMap((ref) => ["--pr", ref]);
  const id = idIn((await pr.decide("record", "--mark", "👍", "--class", "proof-gap", "--kind", "prod-shape", ...prs)).output);

  for (const ref of ["example/product#43", "example/product#44"]) expect((await pr.decide("list", "--pr", ref)).output).toContain(`[${id}]`);
  expect((await pr.decide("list", "--pr", "example/product#45")).output).toBe("No decisions.");
  expect(lineOf((await pr.fleet("gate")).output, "prod-shape:")).toContain(`accepted by 👍 decision ${id}`);
  await expect(pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "prod-shape", "--pr", "example/product#45", "--message", "request-1:0")).rejects.toThrow("The question the user answered does not name example/product#45");
});

test("one answer records one decision: the same message twice is refused", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  pr.chooseGap("prod-shape", "No sandbox");
  const id = idIn((await acceptGap(pr, "prod-shape")).output);
  await expect(acceptGap(pr, "prod-shape")).rejects.toThrow(`That answer is already recorded as decision ${id}. One answer records one decision`);
  await expect(acceptGap(pr, "prod-shape", "--message", "request-1:0")).rejects.toThrow(`already recorded as decision ${id}`);
  expect((await pr.decide("list")).output.split("\n")).toHaveLength(1);
});

test("--message takes an earlier answer by its id, and --words or --message alone", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  pr.chooseGap("prod-shape", "No sandbox", "Accept the gap (Recommended)");
  pr.chooseGap("prod-shape", "No sandbox", "Keep the gap open");
  await expect(acceptGap(pr, "prod-shape")).rejects.toThrow(`The user chose "Keep the gap open", which does not accept the gap`);
  await expect(acceptGap(pr, "prod-shape", "--message", "request-9:0")).rejects.toThrow("No message of the user's in thread thread-1 has the id request-9:0");
  await expect(acceptGap(pr, "prod-shape", "--message", "request-1:0", "--words", `2026-10-25 "Accept the gap (Recommended)"`)).rejects.toThrow("Pass --message or --words, not both");
  const recorded = await acceptGap(pr, "prod-shape", "--message", "request-1:0");
  expect(recorded.output).toBe(`- 👤 **Accept the prod-shape gap? example/product#42: No sandbox** 2026-10-25 "Accept the gap (Recommended)" (the user, proof-gap, thread mcp:thread-1) [${idIn(recorded.output)}]`);
});

test("a plain yes accepts the gap the question named; an answer that keeps it open or says no never does", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  pr.chooseGap("prod-shape", "No sandbox", "No, keep it open");
  await expect(acceptGap(pr, "prod-shape")).rejects.toThrow(`The user chose "No, keep it open", which does not accept the gap`);
  pr.chooseGap("prod-shape", "No sandbox", "Yes");
  expect((await acceptGap(pr, "prod-shape")).code).toBe(0);
  expect((await pr.fleet("gate")).code).toBe(0);
});

test("a legacy acceptance in the gap file still counts, and survives a new reason", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  const head = await pr.git("rev-parse", "HEAD");
  const legacy = { commit: head, reason: "No sandbox", recordedAt: "2026-10-20T10:00:00.000Z", acceptance: { instruction: `2026-10-20 "Accept the gap"`, acceptedAt: "2026-10-20T10:05:00.000Z" } };
  writeFileSync(join(pr.pullRequest, "gaps/prod-shape.json"), JSON.stringify(legacy));
  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(0);
  expect(lineOf(gate.output, "prod-shape:")).toBe(`prod-shape: gap from ${head.slice(0, 7)}, accepted ("2026-10-20 "Accept the gap""): No sandbox`);

  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "The sandbox has no production rows");
  expect(lineOf((await pr.fleet("gate")).output, "prod-shape:")).toBe(`prod-shape: gap from ${head.slice(0, 7)}, accepted ("2026-10-20 "Accept the gap""): The sandbox has no production rows`);
});

test("off the hub the ledger is read and appended over SSH to the hub alias", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  const { remote, hosts } = hubAt(pr);
  pr.chooseGap("prod-shape", "No sandbox");
  const id = idIn((await acceptGap(pr, "prod-shape")).output);

  expect(existsSync(join(pr.home, ".local/state/fleet/decisions.jsonl"))).toBe(false);
  const lines = readFileSync(join(remote, ".local/state/fleet/decisions.jsonl"), "utf8").trim().split("\n");
  expect(lines.map((line) => JSON.parse(line).decision.id)).toEqual([id]);
  expect((statSync(join(remote, ".local/state/fleet/decisions.jsonl")).mode & 0o777).toString(8)).toBe("600");
  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(0);
  expect(lineOf(gate.output, "prod-shape:")).toContain(`accepted by 👤 decision ${id}`);
  expect(new Set(hosts)).toEqual(new Set(["fleet-hub"]));
});

test("on the hub the ledger is the local file, even when the hub alias does not answer", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  const { remote } = hubAt(pr, false);
  const seeded = (home: string, id: string) => {
    const decision = { id, at: "2026-10-25T12:00:00.000Z", class: "status", mark: "🤖", question: "Post the status?", answer: "Post it", rejected: "Wait", reason: "CI is green", scope: { prs: ["example/product#42"] }, where: { thread: "thread-1", machine: "box" } };
    mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
    writeFileSync(join(home, ".local/state/fleet/decisions.jsonl"), JSON.stringify({ type: "decide", decision }) + "\n");
  };
  seeded(pr.home, "d-10ca1000");
  seeded(remote, "d-0e307e00");
  mkdirSync(join(pr.home, ".config/fleet"), { recursive: true });
  writeFileSync(join(pr.home, ".config/fleet/machine.json"), JSON.stringify({ role: "hub" }));

  const listed = (await pr.decide("list")).output;
  expect(listed).toContain("[d-10ca1000]");
  expect(listed).not.toContain("d-0e307e00");
  pr.chooseGap("prod-shape", "No sandbox");
  const id = idIn((await acceptGap(pr, "prod-shape")).output);
  expect(ledgerDecisions(pr).map((decision) => decision.id)).toEqual(["d-10ca1000", id]);
});

test("an unreachable hub fails the gate closed with exit 3, and a record says it was not recorded", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  pr.chooseGap("prod-shape", "No sandbox");
  await acceptGap(pr, "prod-shape");
  hubAt(pr, false);

  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(3);
  expect(lineOf(gate.output, "prod-shape:")).toContain("not accepted: hub unreachable (hub fleet-hub unreachable over SSH (ssh: connect to host fleet-hub port 22: Connection refused)): No sandbox");
  await expect(acceptGap(pr, "prod-shape")).rejects.toThrow("Not recorded: hub fleet-hub unreachable over SSH");
});

test("the merge-risk tier at HEAD limits the agent: none on an ungraded PR, process only on a critical one", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  await expect(agent(pr, "prod-shape")).rejects.toThrow("example/product#42 is ungraded: its merge-risk callout has no Tier line at HEAD. An agent never decides alone on an ungraded PR");
  pr.pullRequestState({ body: graded("critical") });
  await expect(agent(pr, "prod-shape")).rejects.toThrow("example/product#42 is critical at HEAD: an agent decides only process there");
  expect((await agent(pr, "post-deploy-watch")).code).toBe(0);
  pr.pullRequestState({ body: graded("non-critical") });
  const id = idIn((await agent(pr, "prod-shape")).output);
  const accepted = await pr.fleet("gate");
  expect(accepted.code).toBe(0);
  expect(lineOf(accepted.output, "prod-shape:")).toContain(`accepted by 🤖 decision ${id} (Accept it)`);

  pr.pullRequestState({ body: graded("critical") });
  const critical = await pr.fleet("gate");
  expect(critical.code).toBe(3);
  expect(lineOf(critical.output, "prod-shape:")).toContain(`not accepted (🤖 decision ${id} lapsed: critical head)`);
  expect(lineOf(critical.output, "lapsed:")).toContain(`🤖 decision ${id} no longer counts`);

  pr.pullRequestState({ body: "## Merge risk\n\nNo tier yet.\n" });
  expect(lineOf((await pr.fleet("gate")).output, "prod-shape:")).toContain(`not accepted (🤖 decision ${id} lapsed: ungraded)`);
});

test("an agent's ci acceptance counts only while CI has not run on HEAD", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await owing(pr, "ci", "Fork CI cannot create its token");
  pr.ci("none");
  const id = idIn((await agent(pr, "ci")).output);
  const none = await pr.fleet("gate");
  expect(none.code).toBe(0);
  expect(lineOf(none.output, "ci:")).toContain(`accepted by 🤖 decision ${id}`);

  pr.ci([{ name: "test", bucket: "fail" }]);
  const red = await pr.fleet("gate");
  expect(red.code).toBe(3);
  expect(lineOf(red.output, "ci:")).toContain(`not accepted (🤖 decision ${id} lapsed: CI on HEAD is red)`);
});

test("the user's keep-owed outranks an agent's acceptance and no void lifts it; a voided decision counts no more", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await owing(pr, "prod-shape");
  const agents = idIn((await agent(pr, "prod-shape")).output);
  expect((await pr.fleet("gate")).code).toBe(0);

  pr.chooseGap("prod-shape", "No sandbox", "Keep the gap open");
  await expect(acceptGap(pr, "prod-shape")).rejects.toThrow("does not accept the gap");
  const kept = idIn((await acceptGap(pr, "prod-shape", "--keep-owed")).output);
  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(3);
  expect(lineOf(gate.output, "prod-shape:")).toContain(`not accepted (🤖 decision ${agents} lapsed: the user keeps it owed, decision ${kept})`);
  await expect(pr.decide("record", "--mark", "🤖", "--class", "proof-gap", "--kind", "prod-shape", "--pr", "example/product#42", "--keep-owed", "--question", "q", "--answer", "a", "--rejected", "r", "--reason", "why")).rejects.toThrow("--keep-owed are the user's");

  await expect(pr.decide("void", kept, "--reason", "The user lifted it")).rejects.toThrow(`Decision ${kept} keeps the gap owed, and only the user lifts it`);
  expect((await pr.fleet("gate")).code).toBe(3);

  const voided = await pr.decide("void", agents, "--reason", "Its condition no longer holds");
  expect(voided.output).toEndWith(`[${agents}] voided: Its condition no longer holds`);
  await expect(pr.decide("void", agents, "--reason", "again")).rejects.toThrow(`Decision ${agents} is already voided`);
  expect((await pr.decide("list", "--live")).output).not.toContain(agents);

  pr.chooseGap("prod-shape", "No sandbox");
  await acceptGap(pr, "prod-shape");
  expect((await pr.fleet("gate")).code).toBe(0);
});

test("an unreachable hub hides no keep-owed: a standing rule never accepts the gap while the ledger cannot be read", async () => {
  const pr = await checkout();
  const rule = "Until 2026-11-02, I accept each owed Prod shape gap.";
  writeFileSync(join(pr.home, ".agents/guides/standing-rules.md"), `- ${rule} \`fleet proof standing --kind prod-shape --until 2026-11-02 --rule "${rule}"\`\n`);
  await owing(pr, "prod-shape");
  await pr.fleet("standing", "--kind", "prod-shape", "--until", "2026-11-02", "--rule", rule);
  const { state } = hubAt(pr);
  pr.chooseGap("prod-shape", "No sandbox", "Keep the gap open");
  await acceptGap(pr, "prod-shape", "--keep-owed");
  expect((await pr.fleet("gate")).code).toBe(3);

  state.hub = "down";
  const gate = await pr.fleet("gate");
  expect(lineOf(gate.output, "prod-shape:")).toContain("not accepted: hub unreachable");
  expect(gate.code).toBe(3);
});

test("record without --message takes the latest answer that names each PR and each gap kind", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  pr.chooseGap("prod-shape", "No sandbox");
  pr.chooseGap("cross-version", "No old client");
  const recorded = await acceptGap(pr, "prod-shape");
  expect(recorded.output).toStartWith("- 👤 **Accept the prod-shape gap? example/product#42: No sandbox**");
  expect((await pr.fleet("gate")).code).toBe(0);
});

for (const where of ["this machine", "the hub"]) test(`a record after a torn last line on ${where} still lands on its own line, and the torn line costs only itself`, async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await owing(pr, "prod-shape");
  const home = where === "the hub" ? hubAt(pr).remote : pr.home;
  const agents = idIn((await agent(pr, "prod-shape")).output);
  appendFileSync(join(home, ".local/state/fleet/decisions.jsonl"), `{"type":"decide","decision":{"id":"d-70`);

  pr.chooseGap("prod-shape", "No sandbox", "Keep the gap open");
  const kept = idIn((await acceptGap(pr, "prod-shape", "--keep-owed")).output);
  const gate = await pr.fleet("gate");
  expect(lineOf(gate.output, "prod-shape:")).toContain(`not accepted (🤖 decision ${agents} lapsed: the user keeps it owed, decision ${kept})`);
  expect(gate.code).toBe(3);
});

test("a record fails unless its decision is in the ledger when it re-reads it", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await owing(pr, "prod-shape");
  hubAt(pr, "drops appends");
  await expect(agent(pr, "prod-shape")).rejects.toThrow("is not in the decision ledger when Fleet reads it back");
  pr.chooseGap("prod-shape", "No sandbox");
  await expect(acceptGap(pr, "prod-shape")).rejects.toThrow("is not in the decision ledger when Fleet reads it back");
});

test("a review override the hub wrote, but whose acknowledgement SSH lost, keeps its round", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const { remote } = hubAt(pr, "loses the acknowledgement of appends");
  pr.choose("Run one more round");
  const started = await pr.fleet("review-start", "--scope", "full", "--override", `2026-10-25 "Run one more round"`);
  expect(started.code).toBe(0);
  const round = JSON.parse(readFileSync(join(pr.pullRequest, "reviews/1/round.json"), "utf8"));
  const hub = readFileSync(join(remote, ".local/state/fleet/decisions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).decision.id);
  expect(hub).toEqual([round.decision.id]);
});

const overrideStart = ["review-start", "--scope", "full", "--override", `2026-10-25 "Run one more round"`];
const finishRound = (pr: Checkout) => {
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  return pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md");
};
const roundDecision = (pr: Checkout) => JSON.parse(readFileSync(join(pr.pullRequest, "reviews/1/round.json"), "utf8")).decision.id as string;

test("a review-start that dies before its decision reaches the ledger records that decision before review-finish saves the round", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "stalls on appends");
  pr.choose("Run one more round");
  void pr.fleetAs(await exitedPid(), ...overrideStart);
  await hub.appendStalled;
  hub.state.hub = "up";

  expect((await finishRound(pr)).code).toBe(0);
  expect((await pr.decide("list", "--pr", "example/product#42")).output).toContain(`[${roundDecision(pr)}]`);
});

test("a review-start whose process is gone and whose append fails after review-finish saved the round keeps the round and its findings", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "stalls on appends");
  pr.choose("Run one more round");
  const starting = pr.fleetAs(await exitedPid(), ...overrideStart);
  await hub.appendStalled;
  hub.state.hub = "up";
  expect((await finishRound(pr)).code).toBe(0);

  hub.state.hub = "down";
  hub.releaseAppends();
  await expect(starting).rejects.toThrow("Not recorded");
  hub.state.hub = "up";
  expect(readFileSync(join(pr.pullRequest, "reviews/1/findings.md"), "utf8")).toBe("No findings.\n");
  const listed = (await pr.decide("list", "--pr", "example/product#42")).output.split("\n").filter((line) => line.startsWith("- "));
  expect(listed).toEqual([expect.stringContaining(`[${roundDecision(pr)}]`)]);
});

test("a review-start whose decision the hub drops keeps its round, and the same command records that decision", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round");
  await expect(pr.fleet(...overrideStart)).rejects.toThrow("is not in the decision ledger when Fleet reads it back. Run the same command again");
  const decision = roundDecision(pr);

  hub.state.hub = "up";
  const started = await pr.fleet(...overrideStart);
  expect(started.code).toBe(0);
  expect(JSON.parse(started.output)).toMatchObject({ round: 1, id: "1" });
  expect(roundDecision(pr)).toBe(decision);
  expect((await finishRound(pr)).code).toBe(0);
  const listed = (await pr.decide("list", "--pr", "example/product#42")).output.split("\n").filter((line) => line.startsWith("- "));
  expect(listed).toEqual([expect.stringContaining(`[${decision}]`)]);
});

test("a review-start with another scope refuses the round whose decision is not recorded yet and names it, and the same command still takes it", async () => {
  const pr = await checkout();
  const reviewed = await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round");
  await expect(pr.fleet(...overrideStart)).rejects.toThrow("Not recorded");
  const decision = roundDecision(pr);
  hub.state.hub = "up";

  const round = join(pr.pullRequest, "reviews/1");
  await expect(pr.fleet("review-start", "--scope", "final", "--base", reviewed, "--agent", "one last read")).rejects.toThrow(`Review round 1 at this HEAD is reserved with --scope full, and its decision is not recorded yet. Run its command again with --scope full to record it, or remove ${round} to drop it`);
  expect(roundDecision(pr)).toBe(decision);
  expect((await pr.fleet(...overrideStart)).code).toBe(0);
  expect((await finishRound(pr)).code).toBe(0);
  expect(await listedDecisions(pr)).toEqual([expect.stringContaining(`[${decision}]`)]);
});

test("a review-start for a final read in another phase refuses the final read whose decision is not recorded yet", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewed = await reviewHead(pr);
  await pr.commit("feature.txt", "newer\n");
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round");
  await expect(pr.fleet("review-start", "--scope", "final", "--base", reviewed, "--override", `2026-10-25 "Run one more round"`)).rejects.toThrow("Not recorded");
  hub.state.hub = "up";

  await expect(pr.fleet("review-start", "--scope", "final", "--base", reviewed, "--phase", "babysit", "--agent", "babysit read")).rejects.toThrow("Review round final-1 at this HEAD is reserved with --scope final --base");
});

test("review-finish saves a round whose decision is recorded while the hub is down", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr);
  pr.choose("Run one more round");
  expect((await pr.fleet(...overrideStart)).code).toBe(0);

  hub.state.hub = "down";
  expect((await finishRound(pr)).code).toBe(0);
  expect(readFileSync(join(pr.pullRequest, "reviews/1/findings.md"), "utf8")).toBe("No findings.\n");
});

test("review-finish refuses a round whose decision is not recorded while the hub is down, and saves it once the hub is back", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round");
  await expect(pr.fleet(...overrideStart)).rejects.toThrow("Not recorded");

  hub.state.hub = "down";
  await expect(finishRound(pr)).rejects.toThrow("Run the same command again once the hub is back");
  expect(existsSync(join(pr.pullRequest, "reviews/1/findings.md"))).toBe(false);
  hub.state.hub = "up";
  expect((await finishRound(pr)).code).toBe(0);
  expect((await pr.decide("list", "--pr", "example/product#42")).output).toContain(`[${roundDecision(pr)}]`);
});

const listedDecisions = async (pr: Checkout) => (await pr.decide("list", "--pr", "example/product#42")).output.split("\n").filter((line) => line.startsWith("- "));
const hubLines = (remote: string) => readFileSync(join(remote, ".local/state/fleet/decisions.jsonl"), "utf8").trim().split("\n");

test("a second command on a round that a running command works on stops and names that process, and runs once that command ends", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "stalls on appends");
  pr.choose("Run one more round");
  const first = pr.fleet(...overrideStart);
  await hub.appendStalled;
  hub.state.hub = "up";

  const round = join(pr.pullRequest, "reviews/1");
  await expect(pr.fleet(...overrideStart)).rejects.toThrow(`Process ${process.pid}, another fleet proof command, works on ${round} and holds its lock ${join(round, "round.lock")}. Wait for it to end, then run this command again`);
  await expect(finishRound(pr)).rejects.toThrow(`Process ${process.pid}`);
  hub.releaseAppends();
  await expect(first).rejects.toThrow("Not recorded");

  expect((await pr.fleet(...overrideStart)).code).toBe(0);
  expect((await finishRound(pr)).code).toBe(0);
  expect(await listedDecisions(pr)).toEqual([expect.stringContaining(`[${roundDecision(pr)}]`)]);
});

test("a round whose command died is taken over: the same command records its decision and goes on", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "stalls on appends");
  pr.choose("Run one more round");
  void pr.fleetAs(await exitedPid(), ...overrideStart);
  await hub.appendStalled;
  hub.state.hub = "up";

  const started = await pr.fleet(...overrideStart);
  expect(started.code).toBe(0);
  expect(JSON.parse(started.output)).toMatchObject({ round: 1, id: "1" });
  expect((await finishRound(pr)).code).toBe(0);
  expect(await listedDecisions(pr)).toEqual([expect.stringContaining(`[${roundDecision(pr)}]`)]);
});

test("a lock file that a crashed command left empty holds the round only for a short grace, then the same command takes it over", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round");
  await expect(pr.fleet(...overrideStart)).rejects.toThrow("Not recorded");
  hub.state.hub = "up";
  const round = join(pr.pullRequest, "reviews/1");
  const lock = join(round, "round.lock");
  writeFileSync(lock, "");
  utimesSync(lock, pr.clock.now, pr.clock.now);

  await expect(pr.fleet(...overrideStart)).rejects.toThrow(`Another fleet proof command works on ${round} and holds its lock ${lock}. Wait for it to end, then run this command again`);
  const crashed = new Date(pr.clock.now.getTime() - 120_000);
  utimesSync(lock, crashed, crashed);
  expect((await pr.fleet(...overrideStart)).code).toBe(0);
  expect((await finishRound(pr)).code).toBe(0);
  expect(await listedDecisions(pr)).toEqual([expect.stringContaining(`[${roundDecision(pr)}]`)]);
});

test("a round whose holder's process id now names a process that started later is taken over", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "stalls on appends");
  pr.choose("Run one more round");
  const first = pr.fleet(...overrideStart);
  await hub.appendStalled;
  hub.state.hub = "up";

  pr.startTimes.set(process.pid, "Mon Nov  2 08:00:00 2026");
  const started = await pr.fleet(...overrideStart);
  expect(started.code).toBe(0);
  expect(JSON.parse(started.output)).toMatchObject({ round: 1, id: "1" });
  hub.releaseAppends();
  await first.catch(() => undefined);
  expect((await finishRound(pr)).code).toBe(0);
  expect(await listedDecisions(pr)).toEqual([expect.stringContaining(`[${roundDecision(pr)}]`)]);
});

test("review-finish and --wait on a round that is not reserved say so", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await expect(pr.fleet("review-finish", "--round", "3", "--reviewer", "gpt-6.1-sol", "findings.md")).rejects.toThrow("Review round 3 is not reserved. Reserve it with review-start first");
  await expect(pr.fleet("review", "--wait", "--round", "3")).rejects.toThrow("Review round 3 is not reserved. Reserve it with review-start first");
});

test("while the hub is down, a round at an older commit whose decision is not recorded keeps its reservation, and a review that records no decision still runs", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  const reviewed = await reviewHead(pr);
  await pr.commit("feature.txt", "newer\n");
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round");
  await expect(pr.fleet("review-start", "--scope", "final", "--base", reviewed, "--override", `2026-10-25 "Run one more round"`)).rejects.toThrow("Not recorded");
  const stranded = readFileSync(join(pr.pullRequest, "reviews/final-1/round.json"), "utf8");
  const head = await pr.commit("feature.txt", "newest\n");
  hub.state.hub = "down";
  fakeModel(pr, "REVIEWER", "No findings.");

  const review = await pr.fleet("review", "--scope", "fixes", "--base", reviewed);
  expect(review.code).toBe(0);
  expect(JSON.parse(review.output.split("\n")[0]!)).toMatchObject({ round: 2, id: "2" });
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "reviews/2/round.json"), "utf8"))).toMatchObject({ commit: head });
  expect(readFileSync(join(pr.pullRequest, "reviews/final-1/round.json"), "utf8")).toBe(stranded);
});

test("a rerun whose decision is already in the ledger appends it no second time", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "stalls after it lands an append");
  pr.choose("Run one more round");
  void pr.fleetAs(await exitedPid(), ...overrideStart);
  await hub.appendStalled;
  hub.state.hub = "up";

  expect((await pr.fleet(...overrideStart)).code).toBe(0);
  expect((await finishRound(pr)).code).toBe(0);
  expect(hubLines(hub.remote).map((line) => JSON.parse(line).decision.id)).toEqual([roundDecision(pr)]);
});

test("a late command that marks the round recorded keeps the reviewer that review-finish saved", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "stalls after it lands an append");
  pr.choose("Run one more round");
  const late = pr.fleetAs(await exitedPid(), ...overrideStart);
  await hub.appendStalled;
  hub.state.hub = "up";
  expect((await finishRound(pr)).code).toBe(0);

  hub.releaseAppends();
  expect((await late).code).toBe(0);
  expect((await pr.fleet("show")).output.split("\n")).toEqual([
    expect.stringMatching(/^round 1 on \w+: finished by gpt-6\.1-sol, saved by the author: /),
    `decided by 👤 decision ${roundDecision(pr)}`,
  ]);
});

test("a round whose decision never reached the ledger, reserved for an older commit, gives way to the next round", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  const hub = hubAt(pr, "drops appends");
  pr.choose("Run one more round");
  await expect(pr.fleet(...overrideStart)).rejects.toThrow("Not recorded");
  const fixed = await pr.commit("feature.txt", "newer\n");
  hub.state.hub = "up";

  const started = await pr.fleet(...overrideStart);
  expect(started.code).toBe(0);
  expect(JSON.parse(started.output)).toMatchObject({ round: 1, id: "1" });
  expect((await finishRound(pr)).code).toBe(0);
  expect((await pr.fleet("show")).output).toContain(`round 1 on ${fixed.slice(0, 7)}: finished by gpt-6.1-sol`);
  expect(await listedDecisions(pr)).toEqual([expect.stringContaining(`[${roundDecision(pr)}]`)]);
});

test("a plain yes accepts a gap only when its question asks to accept that gap", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  pr.choose("Yes", "Keep the prod-shape gap on example/product#42 owed?");
  await expect(acceptGap(pr, "prod-shape")).rejects.toThrow(`The user chose "Yes" to a question that does not ask "Accept the prod-shape gap?"`);
  expect((await pr.fleet("gate")).code).toBe(3);
});

test("an agent's acceptance that lapses under real evidence at HEAD is no lapse the gate prints", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await owing(pr, "prod-shape");
  await agent(pr, "prod-shape");
  pr.pullRequestState({ body: graded("critical") });
  writeFileSync(join(pr.repository, "rows.log"), "$ psql -c 'select 1'\n1\nexit=0\n");
  await pr.fleet("save", "--kind", "prod-shape", join(pr.repository, "rows.log"));
  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(0);
  expect(gate.output).not.toContain("lapsed");
});

test("gate --json prints the proof summary: each owed kind's state with its accepting decision, the tier, and the lapsed and voided ids; the gate prints its lines from it", async () => {
  const pr = await checkout();
  const earlier = await pr.commit("feature.txt", "first\n");
  writeFileSync(join(pr.repository, "diff.log"), "old and new output match on 200 rows");
  await pr.fleet("save", "--kind", "shadow-diff", "diff.log");
  const head = await pr.commit("feature.txt", "second\n");
  await pr.fleet("save", "--kind", "shadow-diff", "--reuse-from", earlier.slice(0, 8), "--reason", "The later commit only renames a variable");
  await pr.fleet("require", "--kinds", "live-run,ui-walk,prod-shape,cross-version,shadow-diff,post-deploy-watch");
  writeFileSync(join(pr.repository, "run.log"), "sent 1 email, delivered");
  await pr.fleet("save", "--kind", "live-run", "run.log");
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access");
  await pr.fleet("gap", "--kind", "cross-version", "--reason", "No older client to run");
  await reviewHead(pr);
  pr.chooseGap("prod-shape", "No production read access");
  const users = idIn((await acceptGap(pr, "prod-shape")).output);
  pr.pullRequestState({ body: graded("non-critical") });
  const lapsed = idIn((await agent(pr, "cross-version")).output);
  const voided = idIn((await agent(pr, "ui-walk")).output);
  await pr.decide("void", voided, "--reason", "HEAD now changes the UI");
  pr.pullRequestState({ body: graded("critical") });

  const json = await pr.fleet("gate", "--json");
  expect(json.code).toBe(1);
  const summary = JSON.parse(json.output);
  expect(summary).toMatchObject({ repository: "example/product", pr: 42, commit: head, tier: "critical", code: 1, lapsed: [lapsed], voided: [voided] });
  expect(summary.kinds.map(({ line: _, ...kind }: { line: string }) => kind)).toEqual([
    { kind: "live-run", state: "ran", commit: head, directory: expect.stringContaining("live-run") },
    { kind: "ui-walk", state: "missing" },
    { kind: "prod-shape", state: "gap", accepted: true, gap: { commit: head, reason: "No production read access", accepted: { by: "the user", mark: "👤", id: users }, text: `accepted by 👤 decision ${users} (2026-10-25 "Accept the gap")` } },
    { kind: "cross-version", state: "gap", accepted: false, gap: { commit: head, reason: "No older client to run", lapsed: { id: lapsed, reason: "critical head" }, text: `not accepted (🤖 decision ${lapsed} lapsed: critical head)` } },
    { kind: "shadow-diff", state: "reused", from: earlier, reason: "The later commit only renames a variable", directory: expect.stringContaining("shadow-diff") },
    { kind: "post-deploy-watch", state: "pending" },
  ]);
  expect(summary.review).toMatchObject({ state: "covered", unanswered: [] });
  expect(summary.head).toMatchObject({ state: "pushed" });
  expect(summary.ci).toMatchObject({ state: "green" });

  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(1);
  const lines = [summary.owed.line, ...summary.kinds.map((kind: { line: string }) => kind.line), summary.review.line, summary.head.line, summary.ci.line, summary.lapsedLine].filter(Boolean);
  expect(gate.output.split("\n")).toEqual([...lines, "gate: fail (exit 1)"]);
  expect(lineOf(gate.output, "cross-version:")).toBe(`cross-version: gap from ${head.slice(0, 7)}, not accepted (🤖 decision ${lapsed} lapsed: critical head): No older client to run`);
});

const ledgerFile = (pr: Checkout) => join(pr.home, ".local/state/fleet/decisions.jsonl");

test("the user reverses an agent decision with their words in the thread: it prints as 👤 with the replaced answer struck through, and counts no more", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await owing(pr, "prod-shape");
  const id = idIn((await agent(pr, "prod-shape")).output);
  expect((await pr.fleet("gate")).code).toBe(0);
  pr.say("No, run the prod-shape proof");

  await expect(pr.decide("reverse", id, "--words", `2026-10-25 "Words they never typed"`, "--thread", "thread-1")).rejects.toThrow(`"words they never typed" is not in a message of the user's in thread thread-1`);
  const reversed = await pr.decide("reverse", id, "--words", `2026-10-25 "No, run the prod-shape proof"`, "--thread", "thread-1");
  expect(reversed.code).toBe(0);
  const line = `- 👤 **Accept the prod-shape gap?** 2026-10-25 "No, run the prod-shape proof" (reversed 2026-10-25 from ~~🤖 Accept it Rejected: Ask the user.~~) (the user, proof-gap, thread thread-1) [${id}]`;
  expect(reversed.output).toBe(line);

  const gate = await pr.fleet("gate");
  expect(gate.code).toBe(3);
  expect(lineOf(gate.output, "prod-shape:")).toEndWith(", not accepted: No sandbox");
  expect((await pr.decide("list", "--live")).output).toBe("No decisions.");
  expect((await pr.decide("list")).output).toBe(line);
  await expect(pr.decide("reverse", id, "--words", `2026-10-25 "No, run the prod-shape proof"`, "--thread", "thread-1")).rejects.toThrow(`Decision ${id} is already reversed`);

  const olderReader = readFileSync(ledgerFile(pr), "utf8").trim().split("\n").map((text) => JSON.parse(text) as LedgerEvent).filter((event) => event.type === "decide" || event.type === "void");
  expect(fold(olderReader).find((decision) => decision.id === id)?.voided).toBeDefined();
});

test("a reversal takes only the user's own words in the T3 app, never a GitHub comment, which agents also post as the user", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await owing(pr, "prod-shape");
  const id = idIn((await agent(pr, "prod-shape")).output);
  const reverse = (words = `2026-10-25 "Reverse that one"`) => pr.decide("reverse", id, "--words", words, "--thread", "thread-1");

  pr.githubComment(123, "the-user", "Reverse that one", "2026-10-25T13:00:00Z");
  await expect(pr.decide("reverse", id, "--words", `2026-10-25 "Reverse that one"`, "--comment", "https://github.com/example/product/pull/42#issuecomment-123")).rejects.toThrow("Unknown option --comment");
  await expect(pr.decide("reverse", id, "--words", `2026-10-25 "Reverse that one"`)).rejects.toThrow("Pass --thread with the T3 thread where the user reversed it");
  await expect(reverse(`2026-10-25 "***"`)).rejects.toThrow("Quote the user's words with the date they wrote them");
  await expect(reverse()).rejects.toThrow(`"reverse that one" is not in a message of the user's in thread thread-1`);
  expect((await pr.fleet("gate")).code).toBe(0);

  pr.clock.now = new Date("2026-10-25T13:00:00Z");
  pr.say("Reverse that one");
  expect((await reverse()).output).toStartWith(`- 👤 **Accept the prod-shape gap?** 2026-10-25 "Reverse that one" (reversed 2026-10-25 from ~~🤖 Accept it`);
  expect((await pr.fleet("gate")).code).toBe(3);
});
test("two reversals in one ask class within 28 days brake it until the user lifts it; 29 days apart they do not", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  const design = (question: string) => pr.decide("record", "--mark", "🤖", "--class", "design", "--pr", "example/product#42", "--question", question, "--answer", "Keep one module", "--rejected", "Split it", "--reason", "Small change");
  const on = (day: string) => { pr.clock.now = new Date(`${day}T10:00:00Z`); };
  const reverseOn = (day: string, id: string, words: string) => { on(day); pr.say(words); return pr.decide("reverse", id, "--words", `${day} "${words}"`, "--thread", "thread-1"); };
  const lift = (day: string, words: string) => pr.decide("lift", "--class", "proof-gap", "--words", `${day} "${words}"`, "--thread", "thread-1");
  const liftQuestion = "Lift the brake on proof-gap decisions of example/product#42?";
  const ids: string[] = [];
  on("2026-09-25");
  for (let i = 0; i < 3; i++) ids.push(idIn((await agent(pr, "prod-shape")).output));
  const firstDesign = idIn((await design("Where does the parser go?")).output);
  const secondDesign = idIn((await design("Where does the printer go?")).output);

  await reverseOn("2026-10-01", ids[0]!, "No");
  await reverseOn("2026-10-29", ids[1]!, "Not this either");
  await reverseOn("2026-10-01", firstDesign, "Wrong call");
  await reverseOn("2026-10-30", secondDesign, "Also wrong");
  appendFileSync(ledgerFile(pr), ['{"type":"lift","class":"proof-gap","words":"Lift it","thread":"thread-1","message":"m0","at":"z"}', `{"type":"reverse","id":"${ids[2]}","words":"No","thread":"thread-1","message":"m0","at":"2026-10-0"}`].join("\n") + "\n");
  on("2026-11-01");
  await expect(agent(pr, "prod-shape")).rejects.toThrow(`The proof-gap class is braked: the user reversed decisions ${ids[0]} and ${ids[1]} within 28 days`);
  expect((await design("Where does the report go?")).code).toBe(0);

  await expect(pr.decide("lift", "--class", "design", "--words", `2026-11-01 "Lift it"`, "--thread", "thread-1")).rejects.toThrow("The design class is not braked");
  on("2026-11-05");
  pr.say("Lift it, decide gaps again");
  await expect(lift("2026-11-05", "Lift it, decide gaps again")).rejects.toThrow(`"Lift it, decide gaps again" is a message the user typed. Only their answer to your question tool lifts a brake`);
  pr.choose("Lift it", liftQuestion);
  const lifted = await lift("2026-11-05", "Lift it");
  expect(lifted.output).toBe(`Lifted the brake on proof-gap (reversals of ${ids[0]} and ${ids[1]}): the agent decides its asks alone again. (the user, 2026-11-05 "Lift it", thread thread-1)`);
  const fourth = idIn((await agent(pr, "prod-shape")).output);

  await reverseOn("2026-11-06", ids[2]!, "Wrong again");
  await reverseOn("2026-11-07", fourth, "And again");
  await expect(agent(pr, "prod-shape")).rejects.toThrow(`braked: the user reversed decisions ${ids[2]} and ${fourth}`);
  await expect(lift("2026-11-05", "Lift it")).rejects.toThrow("That message already lifted the proof-gap brake on 2026-11-05. One message lifts one brake");
  on("2026-11-06");
  pr.choose("Lift it now", liftQuestion);
  await expect(lift("2026-11-06", "Lift it now")).rejects.toThrow(`The user wrote that before the brake, which the reversal of ${fourth} set on 2026-11-07. Only an answer after it lifts it`);
  on("2026-11-08");
  pr.choose("Lift it once more", liftQuestion);
  expect((await lift("2026-11-08", "Lift it once more")).code).toBe(0);
  expect((await agent(pr, "prod-shape")).code).toBe(0);
});

test("a braked review class refuses review --agent", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  pr.pullRequestState({ body: graded("non-critical") });
  const round = () => pr.decide("record", "--mark", "🤖", "--class", "review", "--pr", "example/product#42", "--question", "Run another round?", "--answer", "Run it", "--rejected", "Ask the user", "--reason", "The arbiter escalated");
  for (const words of ["Stop the rounds", "No more rounds"]) {
    const id = idIn((await round()).output);
    pr.say(words);
    await pr.decide("reverse", id, "--words", `2026-10-25 "${words}"`, "--thread", "thread-1");
  }
  await expect(pr.fleet("review-start", "--scope", "full", "--agent", "The arbiter escalated")).rejects.toThrow("The review class is braked");
});

test("the user's override takes a round whose agent decision never reached the ledger before its class was braked", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  pr.pullRequestState({ body: graded("non-critical") });
  const hub = hubAt(pr, "drops appends");
  await expect(pr.fleet("review-start", "--scope", "full", "--agent", "The arbiter escalated")).rejects.toThrow("Not recorded");
  hub.state.hub = "up";
  const round = () => pr.decide("record", "--mark", "🤖", "--class", "review", "--pr", "example/product#42", "--question", "Run another round?", "--answer", "Run it", "--rejected", "Ask the user", "--reason", "The arbiter escalated");
  for (const words of ["Stop the rounds", "No more rounds"]) {
    const id = idIn((await round()).output);
    pr.say(words);
    await pr.decide("reverse", id, "--words", `2026-10-25 "${words}"`, "--thread", "thread-1");
  }
  await expect(pr.fleet("review-start", "--scope", "full", "--agent", "The arbiter escalated")).rejects.toThrow("braked");

  pr.choose("Run one more round");
  const started = await pr.fleet("review-start", "--scope", "full", "--override", `2026-10-25 "Run one more round"`);
  expect(started.code).toBe(0);
  const decision = JSON.parse(readFileSync(join(pr.pullRequest, "reviews/1/round.json"), "utf8")).decision.id;
  expect((await pr.decide("list", "--pr", "example/product#42", "--live")).output).toContain(`👤 **Run one more review round?`);
  expect((await pr.decide("list", "--pr", "example/product#42", "--live")).output).toContain(`[${decision}]`);
});

test("an agent decision that lands while another machine brakes its class counts nowhere, and its lane is told", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  await owing(pr, "prod-shape");
  const first = idIn((await agent(pr, "prod-shape")).output);
  const second = idIn((await agent(pr, "prod-shape")).output);
  pr.say("No");
  await pr.decide("reverse", first, "--words", `2026-10-25 "No"`, "--thread", "thread-1");
  const reversal = { type: "reverse", id: second, words: `2026-10-25 "Not that either"`, comment: "https://github.com/example/product/pull/42#issuecomment-7", machine: "other-box", at: "2026-10-25T12:00:00.000Z" };
  pr.whileGithubReadsPull(`printf '%s\\n' '${JSON.stringify(reversal)}' >> "${ledgerFile(pr)}"`);

  await expect(agent(pr, "prod-shape")).rejects.toThrow("The proof-gap class was braked while this decision was recorded, so it counts nowhere");
  expect((await pr.fleet("gate")).code).toBe(3);
  expect((await pr.decide("list", "--live")).output).toBe("No decisions.");

  const older = { id: "d-0ld0ld01", at: "2026-10-25T12:30:00.000Z", class: "proof-gap", mark: "🤖", question: "Accept the prod-shape gap?", answer: "Accept it", rejected: "Ask the user", reason: "An older Fleet", scope: { prs: ["example/product#42"], kinds: ["prod-shape"] }, effect: "accept", where: { thread: "thread-1", machine: "old-box" } };
  appendFileSync(ledgerFile(pr), JSON.stringify({ type: "decide", decision: older }) + "\n");
  expect((await pr.fleet("gate")).code).toBe(3);
  expect((await pr.decide("list", "--live")).output).toBe("No decisions.");
});

async function reviewPr(pr: Checkout, n: number) {
  fakeModel(pr, "REVIEWER", clean);
  const target = ["--repo", "example/product", "--pr", String(n)];
  await pr.fleet("review", "--lens", "correctness", ...target);
  expect((await pr.fleet("review", "--wait", ...target)).code).toBe(0);
}

test("the end-of-run report prints its five sections in order: still yours, narrow-grant merges, decisions, proofs, side fixes", async () => {
  const pr = await checkout();
  const head = await pr.commit("feature.txt", "new\n");
  const rollouts = join(pr.home, "rollouts.jsonl");
  pr.env.FLEET_SETTINGS = JSON.stringify({ ...settings, "orchestration.rolloutLog": rollouts });
  for (const n of [5, 41, 42, 43]) pr.pullRequestState({ number: n, body: graded("non-critical") });

  await pr.fleet("require", "--kinds", "live-run,prod-shape,shadow-diff", "--repo", "example/product", "--pr", "41");
  await reviewPr(pr, 41);
  await pr.fleet("gap", "--kind", "shadow-diff", "--reason", "No old output to diff", "--repo", "example/product", "--pr", "41");
  writeFileSync(join(pr.repository, "run.log"), "sent 1 email, delivered");
  await pr.fleet("save", "--kind", "live-run", "run.log", "--repo", "example/product", "--pr", "41");
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access", "--repo", "example/product", "--pr", "41");
  pr.chooseGap("prod-shape", "No production read access", "Accept the gap", 41);
  const users = idIn((await pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "prod-shape", "--pr", "example/product#41")).output);
  pr.githubComment(9, "the-user", "Proofs at HEAD: live-run passed.", "2026-10-25T12:00:00Z", 41);
  await pr.fleet("receipt", "--comment", "https://github.com/example/product/pull/41#issuecomment-9", "--repo", "example/product", "--pr", "41");
  pr.pullRequestState({ number: 41, merged: true });

  await pr.fleet("require", "--kinds", "prod-shape,cross-version");
  await reviewPr(pr, 42);
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No sandbox");
  await pr.fleet("gap", "--kind", "cross-version", "--reason", "No older client to run");
  const lapsed = idIn((await agent(pr, "cross-version")).output);
  const reversed = idIn((await pr.decide("record", "--mark", "🤖", "--class", "design", "--pr", "example/product#42", "--question", "Where does the parser go?", "--answer", "A new module", "--rejected", "The shared parser", "--reason", "Smaller diff")).output);
  pr.say("Use the shared parser");
  await pr.decide("reverse", reversed, "--words", `2026-10-25 "Use the shared parser"`, "--thread", "thread-1");
  await expect(pr.decide("record", "--mark", "🤖", "--class", "design", "--pr", "example/product#42", "--question", "q", "--answer", "a", "--rejected", "r", "--reason", "why", "--link", "t3-thread://elsewhere")).rejects.toThrow("--link belongs to a scope decision");
  const side = idIn((await pr.decide("record", "--mark", "🤖", "--class", "scope", "--pr", "example/product#42", "--question", "Fix the flaky clock test on the side?", "--answer", "Yes, in its own thread", "--rejected", "Leave it", "--reason", "It fails one run in ten", "--link", "t3-thread://side-fix")).output);
  await pr.decide("record", "--mark", "🤖", "--class", "design", "--pr", "example/other#5", "--question", "Another lane's choice?", "--answer", "Theirs", "--rejected", "Ours", "--reason", "Not this lane", "--thread", "other-thread");
  pr.chooseGap("judge", "The judge times out", "Yes", 41);
  const recommended = idIn((await pr.decide("record", "--mark", "👍", "--class", "proof-gap", "--kind", "judge", "--pr", "example/product#41")).output);
  pr.chooseGap("prod-shape", "A side PR without a sandbox", "Accept the gap", 45);
  const inThread = idIn((await pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "prod-shape", "--pr", "example/product#45")).output);
  pr.pullRequestState({ number: 42, body: graded("critical (a migration)") });

  await pr.fleet("require", "--none", "--reason", "docs only", "--repo", "example/product", "--pr", "43");
  await reviewPr(pr, 43);
  expect((await pr.fleet("gate", "--repo", "example/product", "--pr", "43")).code).toBe(0);
  expect((await pr.fleet("gate", "--landed", "--repo", "example/product", "--pr", "41")).code).toBe(3);
  expect((await pr.fleet("gate", "--repo", "example/product", "--pr", "42")).code).toBe(3);
  pr.pendingCards.add("thread-1");
  writeFileSync(rollouts, [
    { at: "2026-10-25T09:00:00Z", repo: "example/product", pr: 41, stage: "merged", state: "done", note: "standing merge: narrow grant, card" },
    { at: "2026-10-25T09:05:00Z", repo: "example/product", pr: 44, stage: "merged", state: "done", note: "standing merge: narrow grant" },
    { at: "2026-10-25T09:10:00Z", repo: "example/product", pr: 42, stage: "deployed", state: "done", note: "standing merge: narrow grant" },
    { at: "2026-10-25T09:15:00Z", repo: "example/product", pr: 43, stage: "merged", state: "done", note: "the user's merge word" },
    { at: "yesterday morning", repo: "example/product", pr: 42, stage: "merged", state: "done", note: "standing merge: narrow grant" },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");

  const printed = await pr.decide("report", "--pr", "example/product#41", "--pr", "https://github.com/example/product/pull/42", "--pr", "example/product#43", "--thread", "thread-1");
  expect(printed.code).toBe(0);
  const report = printed.output.split("\n");
  expect(report[0]).toBe("## End-of-run report: example/product#41, example/product#42, example/product#43");
  expect(report.filter((line) => line.startsWith("### "))).toEqual(["### Still yours", "### Merged under the narrow grant", "### Decisions", "### Proofs", "### Side fixes started"]);
  const section = (heading: string) => { const from = report.indexOf(heading) + 1; const to = report.findIndex((line, index) => index >= from && line.startsWith("### ")); return report.slice(from, to < 0 ? undefined : to).filter(Boolean); };

  expect(section("### Still yours")).toEqual([
    "- **Blocker:** example/product#42 is critical at HEAD and its prod-shape gap is not accepted: No sandbox.",
    `- **Blocker:** example/product#42 is critical at HEAD and its cross-version gap is not accepted: No older client to run (🤖 decision ${lapsed} lapsed: critical head).`,
    "- A question card waits for your answer in thread thread-1.",
    `- example/product#41: its proofs are not shown to pass at HEAD ${head.slice(0, 7)} as read now (gate exit 3). Run fleet proof gate --landed in its checkout to see why.`,
    "- Merge example/product#43: its proofs pass, and it waits on your merge word.",
  ]);
  expect(section("### Merged under the narrow grant")).toEqual(["- example/product#41 merged 2026-10-25 09:00 UTC (standing merge: narrow grant, card)", "- example/product#42 merged at an unknown time (standing merge: narrow grant)"]);
  const decisions = section("### Decisions");
  expect(decisions.map((line) => [line.slice(2, 4).trim(), idIn(line)])).toEqual([["👤", users], ["👤", reversed], ["👤", inThread], ["👍", recommended], ["🤖", lapsed], ["🤖", side]]);
  expect(decisions[1]).toContain("(reversed 2026-10-25 from ~~🤖 A new module Rejected: The shared parser.~~)");
  const short = head.slice(0, 7);
  expect(section("### Proofs")).toEqual([
    "| PR | Ran | Deferred | Voided | Receipt |",
    "| --- | --- | --- | --- | --- |",
    `| example/product#41 | live-run at ${short} | prod-shape: No production read access (accepted by 👤 ${users}); shadow-diff: No old output to diff (not accepted); judge: not run at HEAD | none | [receipt](https://github.com/example/product/pull/41#issuecomment-9) |`,
    `| example/product#42 | none | prod-shape: No sandbox (not accepted); cross-version: No older client to run (not accepted); judge: not run at HEAD | ${lapsed} lapsed; ${reversed} reversed | none yet |`,
    "| example/product#43 | none owed (docs only) | none | none | none yet |",
  ]);
  expect(section("### Side fixes started")).toEqual([`- Fix the flaky clock test on the side? Yes, in its own thread: t3-thread://side-fix [${side}]`]);

  pr.env.FLEET_SETTINGS = JSON.stringify(settings);
  const unlogged = (await pr.decide("report", "--pr", "example/product#41")).output.split("\n");
  expect(unlogged[unlogged.indexOf("### Merged under the narrow grant") + 1]).toBe("- No rollout log: the setting orchestration.rolloutLog is empty, so merges under the grant are unknown.");
});

test("a reversal refuses the user's keep-owed: only their acceptance lifts it", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  pr.chooseGap("prod-shape", "No sandbox", "Keep the gap open");
  const kept = idIn((await acceptGap(pr, "prod-shape", "--keep-owed")).output);
  pr.say("Drop that, the gap is fine");

  await expect(pr.decide("reverse", kept, "--words", `2026-10-25 "Drop that, the gap is fine"`, "--thread", "thread-1")).rejects.toThrow(`Decision ${kept} keeps the gap owed, and only the user lifts it`);
  expect((await pr.decide("list", "--live")).output).toContain(kept);
  expect((await pr.fleet("gate")).code).toBe(3);
});

test("a reversal and a lift take the time the user wrote their words, not the time the agent records them", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  const design = (question: string) => pr.decide("record", "--mark", "🤖", "--class", "design", "--pr", "example/product#42", "--question", question, "--answer", "Keep one module", "--rejected", "Split it", "--reason", "Small change");
  const on = (day: string) => { pr.clock.now = new Date(`${day}T10:00:00Z`); };
  on("2026-08-25");
  const first = idIn((await design("Where does the parser go?")).output);
  const second = idIn((await design("Where does the printer go?")).output);
  const third = idIn((await design("Where does the report go?")).output);
  on("2026-09-01");
  pr.say("Wrong call");
  on("2026-10-20");
  pr.say("Also wrong");
  on("2026-10-25");

  expect((await pr.decide("reverse", first, "--words", `2026-09-01 "Wrong call"`, "--thread", "thread-1")).output).toContain("(reversed 2026-09-01 from ~~🤖 Keep one module");
  await pr.decide("reverse", second, "--words", `2026-10-20 "Also wrong"`, "--thread", "thread-1");
  expect((await design("Where does the index go?")).code).toBe(0);

  on("2026-10-21");
  pr.say("Wrong as well");
  on("2026-10-25");
  expect((await pr.decide("reverse", third, "--words", `2026-10-21 "Wrong as well"`, "--thread", "thread-1")).output).toContain("(reversed 2026-10-21 from");
  await expect(design("Where does the cache go?")).rejects.toThrow(`The design class is braked: the user reversed decisions ${second} and ${third}`);

  on("2026-10-22");
  pr.choose("Lift it", "Lift the brake on design decisions of example/product#42?");
  on("2026-10-26");
  expect((await pr.decide("lift", "--class", "design", "--words", `2026-10-22 "Lift it"`, "--thread", "thread-1")).code).toBe(0);
  const lift = readFileSync(ledgerFile(pr), "utf8").trim().split("\n").map((text) => JSON.parse(text) as LedgerEvent).find((event) => event.type === "lift");
  expect(lift).toMatchObject({ at: "2026-10-22T10:00:00.000Z" });
  expect((await design("Where does the cache go?")).code).toBe(0);
});

test("a reversal and a lift fail unless they are in the ledger when Fleet reads it back", async () => {
  const pr = await checkout();
  pr.pullRequestState({ body: graded("non-critical") });
  const { state } = hubAt(pr);
  const design = (question: string) => pr.decide("record", "--mark", "🤖", "--class", "design", "--pr", "example/product#42", "--question", question, "--answer", "Keep one module", "--rejected", "Split it", "--reason", "Small change");
  const ids = [idIn((await design("Where does the parser go?")).output), idIn((await design("Where does the printer go?")).output), idIn((await design("Where does the report go?")).output)];
  pr.say("Wrong call");
  await pr.decide("reverse", ids[0]!, "--words", `2026-10-25 "Wrong call"`, "--thread", "thread-1");

  state.hub = "drops appends";
  pr.say("Also wrong");
  await expect(pr.decide("reverse", ids[1]!, "--words", `2026-10-25 "Also wrong"`, "--thread", "thread-1")).rejects.toThrow("Not recorded: the event is not in the decision ledger when Fleet reads it back");
  expect((await pr.decide("list", "--live")).output).toContain(ids[1]);

  state.hub = "up";
  await pr.decide("reverse", ids[1]!, "--words", `2026-10-25 "Also wrong"`, "--thread", "thread-1");
  pr.clock.now = new Date("2026-10-26T10:00:00Z");
  pr.choose("Lift it", "Lift the brake on design decisions of example/product#42?");
  state.hub = "drops appends";
  await expect(pr.decide("lift", "--class", "design", "--words", `2026-10-26 "Lift it"`, "--thread", "thread-1")).rejects.toThrow("Not recorded: the event is not in the decision ledger when Fleet reads it back");
  state.hub = "up";
  await expect(design("Where does the cache go?")).rejects.toThrow("The design class is braked");
});

test("report --lane reads the lane's revoke lines and late puts from the hub's secret log, under still yours and in their own section", async () => {
  const pr = await checkout();
  const { remote } = hubAt(pr);
  mkdirSync(join(remote, ".config/fleet"), { recursive: true });
  writeFileSync(join(remote, ".config/fleet/machine.json"), JSON.stringify({ role: "hub" }));
  mkdirSync(join(remote, ".local/share/fleet/engine"), { recursive: true });
  writeFileSync(join(remote, ".local/share/fleet/engine/fleet"), `shift\nFLEET_SETTINGS={} FLEET_HANDLERS={} exec bun ${JSON.stringify(join(import.meta.dir, "../../hub/commands/secret.ts"))} "$@"\n`);
  const put = (id: string, name: string, at: string, why: string, lane: string, revoke?: string) => ({ type: "put", id, name, at, why, storeExpiresAt: "2026-10-31T09:00:00.000Z", machine: "box-a", lane, env: "STRIPE_KEY", ...revoke ? { revoke } : {} });
  mkdirSync(join(remote, ".local/state/fleet"), { recursive: true });
  writeFileSync(join(remote, ".local/state/fleet/secrets.jsonl"), [
    put("p-000000000001", "stripe-test", "2026-10-24T09:00:00.000Z", "intake", "example/tickets#401", "https://example.com/revoke/old"),
    put("p-000000000002", "stripe-test", "2026-10-25T09:00:00.000Z", "expired", "example/tickets#401", "https://example.com/revoke/new"),
    put("p-000000000003", "mail-test", "2026-10-25T11:00:00.000Z", "missed", "example/tickets#401"),
    put("p-000000000004", "other-test", "2026-10-25T11:00:00.000Z", "missed", "example/tickets#402", "https://example.com/revoke/b"),
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const report = (await pr.decide("report", "--pr", "example/product#43", "--lane", "example/tickets#401")).output.split("\n");
  expect(report.filter((line) => line.startsWith("### "))).toEqual(["### Still yours", "### Late secret puts", "### Merged under the narrow grant", "### Decisions", "### Proofs", "### Side fixes started"]);
  const section = (heading: string) => { const from = report.indexOf(heading) + 1; return report.slice(from, report.findIndex((line, index) => index >= from && line.startsWith("### "))).filter(Boolean); };
  expect(section("### Still yours").at(-1)).toBe("- Revoke stripe-test (lane example/tickets#401): https://example.com/revoke/new");
  expect(section("### Late secret puts")).toEqual(["- stripe-test put 2026-10-25 09:00 UTC, why expired.", "- **Miss:** mail-test put 2026-10-25 11:00 UTC, why missed."]);
  expect((await pr.decide("report", "--pr", "example/product#43", "--lane", "example/tickets#403")).output).toContain("### Late secret puts\nNone.");
  expect((await pr.decide("report", "--pr", "example/product#43")).output).not.toContain("### Late secret puts");
});
