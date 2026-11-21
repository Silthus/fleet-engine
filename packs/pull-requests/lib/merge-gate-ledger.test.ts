import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mergeGate } from "../../guards/hooks/merge-gate.ts";
import { join } from "node:path";
import { fold, localLedger, type LedgerEvent } from "./decision-ledger.ts";
import { checkout, cleanFixtures, ledgerDecisions, reviewHead } from "./proof-testing.ts";

afterEach(cleanFixtures);

const ledgerFile = (home: string) => join(home, ".local/state/hedge/decisions.jsonl");
const events = (home: string): Record<string, unknown>[] =>
  existsSync(ledgerFile(home)) ? readFileSync(ledgerFile(home), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

test("each gate result, a failure and a pass, lands in the decision ledger at HEAD", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  const head = await pr.git("rev-parse", "HEAD");
  const failed = await pr.hedge("gate");
  expect(failed.code).toBe(1);
  expect(failed.output).not.toContain("merge gate:");
  expect(events(pr.home).filter((event) => event.type === "gate")).toEqual([expect.objectContaining({ commit: head, passed: false })]);

  await pr.hedge("require", "--none", "--reason", "docs only");
  const passed = await pr.hedge("gate");
  expect(passed.code).toBe(0);
  expect(passed.output).toContain("merge gate: pass recorded in the decision ledger");
  expect(passed.output.split("\n").at(-1)).toStartWith("gate: pass");
  expect(events(pr.home).filter((event) => event.type === "gate").at(-1)).toEqual(expect.objectContaining({ type: "gate", repository: "example/product", pr: 42, commit: head, passed: true }));
});

test("the ledger keeps a well-formed gate pass, drops a malformed one, and decisions ignore both", async () => {
  const home = join(await checkout().then((pr) => pr.home), "ledger");
  mkdirSync(join(home, ".local/state/hedge"), { recursive: true });
  const pass = { type: "gate", repository: "example/product", pr: 42, commit: "a".repeat(40), passed: true, machine: "box", at: "2026-11-16T08:00:00Z" };
  const { passed: _, ...unsure } = pass;
  const broken = [{ ...pass, commit: "abc123" }, { ...pass, pr: 0 }, { ...pass, repository: "nobody" }, { ...pass, machine: "" }, { ...pass, passed: "yes" }, unsure];
  writeFileSync(ledgerFile(home), [pass, ...broken].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const read: LedgerEvent[] = await localLedger(home).read();
  expect(read).toEqual([pass as LedgerEvent]);
  expect(fold(read)).toEqual([]);
});

test("a valued option given twice is refused before anything is recorded, so a later --mark 🤖 cannot slip past the 👤 rules", async () => {
  const pr = await checkout();
  pr.chooseGap("judge", "the judge is down");
  await expect(pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "judge", "--pr", "example/product#42", "--mark", "🤖", "--question", "q", "--answer", "a", "--rejected", "r", "--reason", "why"))
    .rejects.toThrow("--mark given twice");
  await expect(pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", "judge", "--pr", "example/product#42", "--thread", "a", "--thread", "b")).rejects.toThrow("--thread given twice");
  expect(ledgerDecisions(pr)).toEqual([]);
});

test("a gate override is the user's 👤 answer for one PR at one full head, with the incident and why", async () => {
  const pr = await checkout();
  const head = "a".repeat(40);
  const override = (...args: string[]) => pr.decide("record", "--class", "merge", "--kind", "gate-override", "--pr", "example/product#42", ...args);
  await expect(override("--mark", "🤖", "--condition", `${head}: incident fix now`, "--question", "q", "--answer", "a", "--rejected", "r", "--reason", "x")).rejects.toThrow("An agent never overrides the merge gate");
  await expect(override("--mark", "👍", "--condition", `${head}: incident fix now`)).rejects.toThrow("--mark 👤");
  await expect(override("--mark", "👤")).rejects.toThrow("full 40-character head sha");
  await expect(override("--mark", "👤", "--condition", "abc123: incident fix now")).rejects.toThrow("full 40-character head sha");
  await expect(override("--mark", "👤", "--pr", "example/product#41", "--condition", `${head}: incident fix now`)).rejects.toThrow("one --pr");
  await expect(pr.decide("record", "--mark", "👤", "--class", "merge", "--kind", "ci", "--pr", "example/product#42")).rejects.toThrow("only --kind gate-override");
  expect(ledgerDecisions(pr)).toEqual([]);

  pr.choose("Keep the gate closed", `Merge example/product#42 at ${head} without a gate pass (gate-override)? The incident cannot wait.`);
  await expect(override("--mark", "👤", "--condition", `${head}: incident fix, the judge is down`)).rejects.toThrow('not "Override the gate"');
  pr.choose("Override the gate", `Merge example/product#42 at ${"b".repeat(40)} without a gate pass (gate-override)? The incident cannot wait.`);
  await expect(override("--mark", "👤", "--condition", `${head}: incident fix, the judge is down`)).rejects.toThrow(`does not name the head ${head}`);
  expect(ledgerDecisions(pr)).toEqual([]);

  pr.choose("Override the gate", `Merge example/product#42 at ${head} without a gate pass (gate-override)? The incident cannot wait.`);
  const recorded = await override("--mark", "👤", "--condition", `${head}: incident fix, the judge is down`);
  expect(recorded.code).toBe(0);
  expect(ledgerDecisions(pr).at(-1)).toMatchObject({ class: "merge", mark: "👤", scope: { prs: ["example/product#42"], kinds: ["gate-override"], condition: `${head}: incident fix, the judge is down` } });
});

test("a gate run that throws after a pass at the same head is shared, so another machine's merge gate refuses the merge", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const head = await pr.git("rev-parse", "HEAD");
  const other = join(tmpdir(), `merge-gate-other-${process.pid}-${Date.now()}`);
  mkdirSync(join(other, ".local/state/hedge"), { recursive: true });
  writeFileSync(join(other, ".local/state/hedge/settings.json"), "{}");
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const mergeThere = async () => {
    writeFileSync(join(other, ".local/state/hedge/decisions.jsonl"), readFileSync(ledgerFile(pr.home), "utf8"));
    return mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: other, env: { HEDGE_SETTINGS: undefined }, github });
  };
  try {
    expect((await pr.hedge("gate")).code).toBe(0);
    expect(await mergeThere()).toBeUndefined();
    pr.clock.now = new Date(pr.clock.now.getTime() + 60_000);
    rmSync(join(pr.home, ".agents/guides/coding-standards.md"));
    expect((await pr.hedge("gate")).code).toBe(1);
    expect((await mergeThere())?.hookSpecificOutput.permissionDecisionReason).toContain("has not passed at the head of example/product#42");
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test("a gate result in the ledger carries the time its run started, the order the gate runs on this machine keep", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const start = pr.clock.now.getTime();
  let reads = 0;
  Object.defineProperty(pr.clock, "now", { get: () => new Date(start + 60_000 * reads++), configurable: true });
  expect((await pr.hedge("gate")).code).toBe(0);
  expect(events(pr.home).filter((event) => event.type === "gate").at(-1)).toMatchObject({ passed: true, at: new Date(start).toISOString() });
});

test("while --wait waits for CI at a head that passed before, another machine's merge gate refuses the merge until the wait ends in a pass", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const head = await pr.git("rev-parse", "HEAD");
  const other = join(tmpdir(), `merge-gate-other-${process.pid}-${Date.now()}`);
  mkdirSync(join(other, ".local/state/hedge"), { recursive: true });
  writeFileSync(join(other, ".local/state/hedge/settings.json"), "{}");
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const mergeThere = async () => {
    writeFileSync(join(other, ".local/state/hedge/decisions.jsonl"), readFileSync(ledgerFile(pr.home), "utf8"));
    return mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: other, env: { HEDGE_SETTINGS: undefined }, github });
  };
  try {
    expect((await pr.hedge("gate")).code).toBe(0);
    pr.clock.now = new Date(pr.clock.now.getTime() + 60_000);
    pr.ci([{ name: "test", bucket: "pending" }]);
    const whileWaiting: (string | undefined)[] = [];
    pr.panel.onPause = async (ms = 0) => {
      whileWaiting.push((await mergeThere())?.hookSpecificOutput.permissionDecisionReason);
      pr.clock.now = new Date(pr.clock.now.getTime() + ms);
      pr.ci([{ name: "test", bucket: "pass" }]);
    };
    expect((await pr.hedge("gate", "--wait", "10")).code).toBe(0);
    expect(whileWaiting[0]).toContain("has not passed at the head of example/product#42");
    expect(await mergeThere()).toBeUndefined();
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test("a pass that another gate run shared after this run started still yields to this run's wait on running CI", async () => {
  const pr = await checkout();
  await pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.hedge("require", "--none", "--reason", "docs only");
  const head = await pr.git("rev-parse", "HEAD");
  const other = join(tmpdir(), `merge-gate-other-${process.pid}-${Date.now()}`);
  mkdirSync(join(other, ".local/state/hedge"), { recursive: true });
  writeFileSync(join(other, ".local/state/hedge/settings.json"), "{}");
  const github = { pull: async () => ({ head, base: "main", defaultBranch: "main", open: true }), pullFor: async () => undefined };
  const mergeThere = async () => {
    writeFileSync(join(other, ".local/state/hedge/decisions.jsonl"), readFileSync(ledgerFile(pr.home), "utf8"));
    return mergeGate({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo example/product" }, cwd: "/" }, { home: other, env: { HEDGE_SETTINGS: undefined }, github });
  };
  try {
    const start = pr.clock.now.getTime();
    const laterPass = { type: "gate", repository: "example/product", pr: 42, commit: head, passed: true, machine: "another-box", at: new Date(start + 500).toISOString() };
    mkdirSync(join(pr.home, ".local/state/hedge"), { recursive: true });
    writeFileSync(ledgerFile(pr.home), (existsSync(ledgerFile(pr.home)) ? readFileSync(ledgerFile(pr.home), "utf8") : "") + JSON.stringify(laterPass) + "\n");
    let reads = 0;
    Object.defineProperty(pr.clock, "now", { get: () => new Date(start + 1_000 * reads++), configurable: true });
    pr.ci([{ name: "test", bucket: "pending" }]);
    const whileWaiting: (string | undefined)[] = [];
    pr.panel.onPause = async () => {
      whileWaiting.push((await mergeThere())?.hookSpecificOutput.permissionDecisionReason);
      pr.ci([{ name: "test", bucket: "pass" }]);
    };
    expect((await pr.hedge("gate", "--wait", "10")).code).toBe(0);
    expect(whileWaiting[0]).toContain("has not passed at the head of example/product#42");
  } finally { rmSync(other, { recursive: true, force: true }); }
});
