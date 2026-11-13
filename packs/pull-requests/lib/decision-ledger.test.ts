import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptGap, checkout, cleanFixtures, graded, ledgerDecisions, reviewHead, settings, type Checkout } from "./proof-testing.ts";

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

type Hub = "up" | "down" | "drops appends" | "loses the acknowledgement of appends";
const refused = { code: 255, stdout: "", stderr: "ssh: connect to host fleet-hub port 22: Connection refused\n" };

function hubAt(pr: Checkout, hub: Hub | boolean = "up") {
  const remote = join(pr.home, "hub-home");
  const hosts: string[] = [];
  const state = { hub: hub === true ? "up" : hub === false ? "down" : hub };
  pr.env.FLEET_SETTINGS = JSON.stringify({ ...settings, "hub.alias": "fleet-hub" });
  pr.hub.ssh = async (host, command, stdin) => {
    hosts.push(host);
    if (state.hub === "down") return refused;
    if (state.hub === "drops appends" && stdin !== undefined) return { code: 0, stdout: "", stderr: "" };
    const child = Bun.spawn(["bash", "-c", command], { env: { HOME: remote, PATH: process.env.PATH }, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (state.hub === "loses the acknowledgement of appends" && stdin !== undefined) return refused;
    return { code, stdout, stderr };
  };
  return { remote, hosts, state };
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

test("a plain yes accepts a gap only when its question asks to accept that gap", async () => {
  const pr = await checkout();
  await owing(pr, "prod-shape");
  pr.choose("Yes", "Keep the prod-shape gap on example/product#42 owed?");
  await expect(acceptGap(pr, "prod-shape")).rejects.toThrow(`The user chose "Yes" to a question that does not ask "Accept the prod-shape gap?"`);
  expect((await pr.fleet("gate")).code).toBe(3);
});

