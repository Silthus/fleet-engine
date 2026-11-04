import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { standingFor } from "./proof.ts";

import { cleanFixtures, fixture, settings, lookup, checkout, reviewHead, decideRule, withDecideRule, finishRound, recordingModel } from "./proof-testing.ts";

afterEach(cleanFixtures);

const command = resolve(dirname(fileURLToPath(import.meta.url)), "../commands/proof.ts");

test("fleet proof explains each command and fails closed with one line when it cannot run", async () => {
  const directory = fixture("fleet-proof-cli-");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'no git remotes found' >&2\nexit 1\n", { mode: 0o755 });
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["bun", command, ...args], {
      cwd: directory, env: { ...process.env, HOME: directory, PATH: `${bin}:${process.env.PATH}`, FLEET_DEBUG: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };

  const help = await run("review-start", "--help");
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("fleet proof review-start --scope fixes --base");
  expect(help.stdout).toContain("--override");
  expect(help.stdout).not.toContain("./fleet");

  const gate = await run("gate", "--commit", "a".repeat(40));
  expect(gate.code).not.toBe(0);
  expect(gate.stdout).toBe("");
  expect(gate.stderr.trim().split("\n")).toEqual([expect.stringContaining("no git remotes found). Pass --repo owner/name --pr number")]);

  const unknown = await run("review-finish", "--findings");
  expect(unknown.code).not.toBe(0);
  expect(unknown.stderr.trim().split("\n")).toEqual([expect.stringContaining("fleet proof review-finish --help")]);
});

test("fleet proof lists only the commands this version ships", async () => {
  const pr = checkout();
  const listed = (await pr.fleet("--help")).output.split("\n").flatMap((line) => /^  fleet proof (\S+)/.exec(line)?.[1] ?? []);
  expect(listed).toEqual(["path", "save", "publish", "require", "review", "show", "respond", "standing", "gap", "gate", "review-start", "review-finish"]);
  await expect(pr.fleet("miss")).rejects.toThrow("Unknown command miss. Run fleet proof --help");
});

test("a clean merge of the base carries the review of the PR forward and records it", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  const reviewed = await reviewHead(pr);
  pr.advanceBase("base.txt", "base\n");
  pr.git("merge", "-q", "--no-edit", "origin/main");
  const merge = pr.git("rev-parse", "HEAD");
  await pr.fleet("require", "--none", "--reason", "fixture");

  const gate = await pr.fleet("gate");

  expect(gate.code).toBe(0);
  expect(gate.output).toContain(`carried forward from the review of ${reviewed.slice(0, 7)}`);
  expect(gate.output.split("\n").at(-1)).toBe(`gate: pass (kinds: none; review: carried from ${reviewed.slice(0, 7)}; CI: green; judge: pass by judge-under-test)`);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "carried", `${merge}.json`), "utf8"))).toMatchObject({ commit: merge, from: reviewed, merges: [merge] });

  pr.commit("feature.txt", "fixed\n");
  expect((await pr.fleet("review-start", "--scope", "final", "--base", merge.slice(0, 8))).output).toContain(`"round":"final"`);
});

test("a merge that changes code while it resolves the base keeps HEAD unreviewed, even from a subdirectory with relative diffs", async () => {
  const pr = checkout();
  pr.commit("shared.txt", "feature\n");
  const subdirectory = join(pr.repository, "docs");
  mkdirSync(subdirectory);
  pr.commit("docs/readme.md", "docs\n");
  const reviewed = await reviewHead(pr);
  pr.advanceBase("shared.txt", "base\n");
  pr.git("merge", "-q", "--no-edit", "origin/main");
  writeFileSync(join(pr.repository, "shared.txt"), "resolved\n");
  pr.git("commit", "-q", "-a", "--no-edit");
  pr.git("config", "diff.relative", "true");

  const gate = await pr.fleetIn(subdirectory, "gate");

  expect(gate.code).toBe(1);
  expect(gate.output).toContain("review: HEAD not reviewed");
  expect(existsSync(join(pr.pullRequest, "carried"))).toBe(false);

  const merge = pr.git("rev-parse", "HEAD");
  mkdirSync(join(pr.pullRequest, "carried"));
  writeFileSync(join(pr.pullRequest, "carried", `${merge}.json`), JSON.stringify({ commit: merge, from: reviewed, merges: [merge] }));
  pr.commit("shared.txt", "fixed\n");
  await expect(pr.fleet("review-start", "--scope", "final", "--base", merge)).rejects.toThrow("Final read base must be");
});

test("a merge of another branch keeps HEAD unreviewed even without conflicts", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  pr.git("checkout", "-q", "-b", "other", "main");
  pr.commit("other.txt", "unreviewed\n");
  pr.git("checkout", "-q", "feature");
  pr.git("merge", "-q", "--no-edit", "other");

  expect((await pr.fleet("gate")).code).toBe(1);
});

test("a checkout without a remote of the PR's repository carries nothing forward", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  pr.advanceBase("base.txt", "base\n");
  pr.git("remote", "set-url", "origin", "https://github.com/someone/fork.git");
  pr.git("merge", "-q", "--no-edit", "origin/main");

  expect((await pr.fleet("gate")).code).toBe(1);
});

test("an override and a gap acceptance need the user's words from the T3 thread they name, kept with the question they answer", async () => {
  const pr = checkout();
  const head = pr.commit("feature.txt", "new\n");
  const answer = `2026-10-24 "Run one more round"`;
  const question = "Run one more review round? example/product#42: round 7 found two new bugs.";

  await expect(pr.fleet("review-start", "--commit", head.slice(0, 8), "--override", `2026-10-24 the user said to ship everything autonomously`, "--thread", "thread-1")).rejects.toThrow("dated quote");
  await expect(pr.fleet("review-start", "--override", answer)).rejects.toThrow("--thread");
  await expect(pr.fleet("review-start", "--override", answer, "--thread", "thread-1")).rejects.toThrow("not in a message of the user's in thread thread-1");

  pr.choose("Run one more round (Recommended)", question);
  await expect(pr.fleet("review-start", "--override", answer, "--thread", "thread-1")).rejects.toThrow("not in a message of the user's in thread thread-1");
  expect((await pr.fleet("review-start", "--commit", head.slice(0, 8), "--override", `2026-10-24 "Run one more round (Recommended)"`, "--thread", "thread-1")).code).toBe(0);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "reviews/1/round.json"), "utf8"))).toMatchObject({
    commit: head, override: `2026-10-24 "Run one more round (Recommended)"`,
    answer: { thread: "mcp:thread-1", message: "request-1:0", words: "Run one more round (Recommended)", answered: question },
  });

  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access");
  pr.chooseGap("prod-shape", "No production read access", "Accept the gap (Recommended)");
  await pr.fleet("gap", "--kind", "prod-shape", "--accept", `2026-10-25 "Accept the gap (Recommended)" for prod-shape on #42`, "--thread", "thread-1");
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "gaps/prod-shape.json"), "utf8")).acceptance).toMatchObject({ answer: { message: "request-2:0", answered: "Accept the prod-shape gap? example/product#42: No production read access" } });
});

test("a gap acceptance needs a recorded gap and the user's words from the T3 thread it names", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  const accept = `2026-10-25 "Accept the gap (Recommended)" for prod-shape on #42`;
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", accept, "--thread", "thread-1")).rejects.toThrow("No prod-shape gap is recorded");

  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access");
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", accept)).rejects.toThrow("--thread");
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", accept, "--thread", "thread-1")).rejects.toThrow("not in a message of the user's in thread thread-1");
  pr.chooseGap("prod-shape", "No production read access", "Accept the gap (Recommended)");
  expect((await pr.fleet("gap", "--kind", "prod-shape", "--accept", accept, "--thread", "thread-1")).code).toBe(0);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "gaps/prod-shape.json"), "utf8"))).toMatchObject({ reason: "No production read access", acceptance: { instruction: accept } });
});

test("the gate fails until the owed proofs are recorded, and a recorded none prints its reason", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  await reviewHead(pr);

  const unrecorded = await pr.fleet("gate");
  expect(unrecorded.code).toBe(1);
  expect(unrecorded.output).toContain("owed proofs: not recorded");

  await pr.fleet("require", "--none", "--reason", "docs only");
  const none = await pr.fleet("gate");
  expect(none.code).toBe(0);
  expect(none.output).toContain("owed proofs: none (docs only)");
  expect(none.output.split("\n").at(-1)).toBe("gate: pass (kinds: none; review: round 1 by gpt-6.1-sol; CI: green; judge: pass by judge-under-test)");

  await pr.fleet("require", "--kinds", "live-run");
  const owed = await pr.fleet("gate");
  expect(owed.code).toBe(1);
  expect(owed.output).toContain("live-run: missing");
});

test("empty evidence and empty findings are refused, and finishing a round names its reviewer", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  writeFileSync(join(pr.repository, "empty.log"), "");
  await expect(pr.fleet("save", "--kind", "live-run", "empty.log")).rejects.toThrow("is empty");

  await pr.fleet("review-start", "--scope", "full");
  writeFileSync(join(pr.repository, "findings.md"), "\n");
  await expect(pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md")).rejects.toThrow("is empty");
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await expect(pr.fleet("review-finish", "--round", "1", "findings.md")).rejects.toThrow("--reviewer is required");
});

test("saved evidence is kept by content under the commit, a UI walk keeps only screenshots, and reuse needs earlier evidence and a reason", async () => {
  const pr = checkout();
  const proved = pr.commit("feature.txt", "new\n");
  writeFileSync(join(pr.repository, "run.log"), "GET /feature 200\n");
  writeFileSync(join(pr.repository, "capture.png"), "Authorization: Bearer invented-token");
  writeFileSync(join(pr.repository, "greeting.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("pixels")]));

  const saved = (await pr.fleet("save", "--kind", "live-run", "run.log", "run.log")).output.split("\n");
  expect(saved).toHaveLength(2);
  expect(saved[0]).toBe(saved[1]);
  expect(saved[0]).toMatch(new RegExp(`^${pr.pullRequest}/${proved}/live-run/[0-9a-f]{64}\\.log$`));
  expect(statSync(saved[0]!).mode & 0o777).toBe(0o600);
  await expect(pr.fleet("save", "--kind", "ui-walk", "capture.png")).rejects.toThrow("only screenshots");
  expect((await pr.fleet("save", "--kind", "ui-walk", "greeting.png")).code).toBe(0);
  await expect(pr.fleet("save", "--kind", "smoke", "run.log")).rejects.toThrow("Unknown proof kind smoke");
  expect((await pr.fleet("path")).output).toBe(join(pr.pullRequest, proved));

  pr.commit("feature.txt", "fixed\n");
  await expect(pr.fleet("save", "--kind", "live-run", "--reuse-from", proved.slice(0, 8))).rejects.toThrow("--reason is required");
  await expect(pr.fleet("save", "--kind", "prod-shape", "--reuse-from", proved.slice(0, 8), "--reason", "same query")).rejects.toThrow(`${proved.slice(0, 7)} has no prod-shape evidence to reuse`);
  await expect(pr.fleet("save", "--kind", "live-run", "--reuse-from", "HEAD", "--reason", "same")).rejects.toThrow("That commit is HEAD");
  expect((await pr.fleet("save", "--kind", "live-run", "--reuse-from", proved.slice(0, 8), "--reason", "the fix renames a local variable")).code).toBe(0);
  expect(readdirSync(join(pr.pullRequest, "reused/live-run"))).toEqual([`${pr.git("rev-parse", "HEAD")}.json`]);
});

test("a standing rule from the user's guides accepts its kind's gaps until its date, and a quote of their instructions is no acceptance", async () => {
  const pr = checkout();
  const rule = "Until 2026-11-02, I accept each owed Prod shape gap.";
  writeFileSync(join(pr.home, ".agents/guides/standing-rules.md"), `# Standing rules\n\n- ${rule} Record it with \`fleet proof standing --kind prod-shape --until 2026-11-02 --rule "${rule}"\`.\n`);
  writeFileSync(join(pr.home, ".agents/guides/skill-settings.md"), "- Sandbox: it has no test user yet, so record its walk as a gap.\n");
  pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.fleet("require", "--kinds", "prod-shape");
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access");

  await expect(pr.fleet("standing", "--kind", "prod-shape", "--until", "2026-11-02", "--rule", "The user accepts every gap of every kind forever")).rejects.toThrow("word for word");
  await expect(pr.fleet("standing", "--kind", "prod-shape,review,judge", "--until", "2026-11-02", "--rule", rule)).rejects.toThrow("word for word");
  await expect(pr.fleet("standing", "--kind", "prod-shape", "--until", "2099-01-01", "--rule", rule)).rejects.toThrow("word for word");
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", `The guide says: ${rule}`)).rejects.toThrow("quotes the user's instructions");
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", "Per my skill settings, sandbox: it has no test user yet, so record its walk as a gap")).rejects.toThrow("quotes the user's instructions");
  await pr.fleet("standing", "--kind", "prod-shape", "--until", "2026-11-02", "--rule", rule);
  expect((await pr.fleet("standing")).output.split("\n").map((line) => JSON.parse(line))).toMatchObject([{ kind: "prod-shape", until: "2026-11-02", rule }]);

  pr.clock.now = new Date("2026-11-01T23:00:00Z");
  const standing = await pr.fleet("gate");
  expect(standing.code).toBe(0);
  expect(standing.output).toContain("accepted by standing rule until 2026-11-02");

  pr.clock.now = new Date("2026-11-02T00:00:00Z");
  expect((await pr.fleet("gate")).code).toBe(3);

  writeFileSync(join(pr.home, ".agents/guides/standing-rules.md"), "# Standing rules\n");
  expect(await standingFor(pr.home, "prod-shape", new Date("2026-11-01T23:00:00Z"))).toBeUndefined();
});

test("under the user's standing review rule, an agent answers an arbiter escalation itself, and the round keeps the escalation and the agent's reason", async () => {
  const pr = checkout();
  withDecideRule(pr);
  const head = pr.commit("feature.txt", "new\n");
  for (const round of ["1", "2"]) {
    await pr.fleet("review-start", ...(round === "1" ? ["--scope", "full"] : ["--scope", "fixes", "--base", head]));
    await finishRound(pr, round);
  }
  pr.env.FLEET_REVIEW_ARBITER = "cat >/dev/null; echo 'ESCALATE: Round 2 undoes the rename round 1 asked for.'";
  const third = ["review-start", "--scope", "fixes", "--base", head];
  const reason = "Round 1 asked for the rename as a nit; keep the reverted name and review the fix.";

  await expect(pr.fleet(...third, "--standing", reason)).rejects.toThrow("No standing rule lets agents decide review rounds");
  await pr.fleet("standing", "--kind", "review,judge,post-deploy-watch", "--until", "2026-11-26", "--rule", decideRule);
  expect((await pr.fleet("standing")).output.split("\n").map((line) => JSON.parse(line).kind)).toEqual(["review", "judge", "post-deploy-watch"]);
  await expect(pr.fleet(...third)).rejects.toThrow("The arbiter escalates: Round 2 undoes the rename round 1 asked for. Ask the user with your question tool");
  await expect(pr.fleet(...third)).rejects.toThrow("or decide yourself under their standing rule with --standing");

  expect((await pr.fleet(...third, "--standing", reason)).code).toBe(0);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "reviews/3/round.json"), "utf8"))).toMatchObject({
    arbiter: { verdict: "escalate", reason: "Round 2 undoes the rename round 1 asked for" },
    standing: { reason, rule: decideRule, until: "2026-11-26" },
  });
  await finishRound(pr, "3");
  expect((await pr.fleet("show", "--round", "3")).output).toContain(`accepted by the standing rule until 2026-11-26: ${reason}`);

  pr.clock.now = new Date("2026-11-26T00:00:00Z");
  await expect(pr.fleet("review-start", "--scope", "fixes", "--base", head, "--standing", reason)).rejects.toThrow("No standing rule lets agents decide review rounds");
});

test("under the user's standing review rule, an agent runs a final read past the ceiling itself", async () => {
  const pr = checkout();
  withDecideRule(pr);
  const reviewed = pr.commit("feature.txt", "new\n");
  await pr.fleet("review-start", "--scope", "full");
  await finishRound(pr, "1");
  await pr.fleet("standing", "--kind", "review", "--until", "2026-11-26", "--rule", decideRule);
  pr.env.FLEET_REVIEW_ARBITER = "cat >/dev/null; echo CONTINUE";
  let base = reviewed;
  for (let read = 1; read <= 6; read++) {
    const fixed = pr.commit("feature.txt", `fix ${read}\n`);
    await pr.fleet("review-start", "--scope", "final", "--base", base);
    await finishRound(pr, `final-${read}`);
    base = fixed;
  }
  pr.commit("feature.txt", "fix 7\n");
  const seventh = ["review-start", "--scope", "final", "--base", base];

  await expect(pr.fleet(...seventh)).rejects.toThrow("6 final reads done in the review phase. Ask the user with your question tool");
  await expect(pr.fleet(...seventh)).rejects.toThrow("or decide yourself under their standing rule with --standing");
  expect((await pr.fleet(...seventh, "--standing", "Read 6 found one real bug in new code; one more read checks its fix.")).code).toBe(0);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "reviews/final-7/round.json"), "utf8"))).toMatchObject({ arbiter: { verdict: "continue" }, standing: { until: "2026-11-26" } });
  await expect(pr.fleet(...seventh, "--standing", "anything", "--override", `2026-10-29 "Run it."`, "--thread", "thread-1")).rejects.toThrow("--override or --standing");
});

test("the review settings set how many reviews run free and where the loop stops", async () => {
  const pr = checkout();
  pr.env.FLEET_SETTINGS = JSON.stringify({ ...settings, "pull-requests.freeReviews": 1, "pull-requests.reviewCeiling": 2 });
  const head = pr.commit("feature.txt", "new\n");
  await pr.fleet("review-start", "--scope", "full");
  await finishRound(pr, "1");
  pr.env.FLEET_REVIEW_ARBITER = "cat >/dev/null; echo 'ESCALATE: Round 1 contradicts itself.'";
  await expect(pr.fleet("review-start", "--scope", "fixes", "--base", head)).rejects.toThrow("The arbiter escalates: Round 1 contradicts itself");
  pr.env.FLEET_REVIEW_ARBITER = "cat >/dev/null; echo CONTINUE";
  await pr.fleet("review-start", "--scope", "fixes", "--base", head);
  await finishRound(pr, "2");
  await expect(pr.fleet("review-start", "--scope", "fixes", "--base", head)).rejects.toThrow("2 panel rounds done. Ask the user with your question tool");
});

test("without a replacement command, the arbiter runs the lookup row of the model table with its provider, model, and effort", async () => {
  const pr = checkout();
  const head = pr.commit("feature.txt", "new\n");
  for (const round of ["1", "2"]) {
    await pr.fleet("review-start", ...(round === "1" ? ["--scope", "full"] : ["--scope", "fixes", "--base", head]));
    await finishRound(pr, round);
  }
  const claude = recordingModel(pr, "claude", "CONTINUE");
  expect((await pr.fleet("review-start", "--scope", "fixes", "--base", head)).code).toBe(0);
  expect(claude.calls()).toEqual([expect.stringMatching(/^-p --model lookup-model --effort medium .*--no-session-persistence$/)]);
  expect(claude.prompt()).toContain("# round 2\n\nFindings of 2.");
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "reviews/3/round.json"), "utf8"))).toMatchObject({ arbiter: { verdict: "continue", model: "lookup-model" } });

  await finishRound(pr, "3");
  pr.env.FLEET_MODELS = JSON.stringify([{ ...lookup, provider: "codex", effort: "low" }]);
  const codex = recordingModel(pr, "codex", "ESCALATE: Round 3 undoes round 2.");
  await expect(pr.fleet("review-start", "--scope", "fixes", "--base", head)).rejects.toThrow("The arbiter escalates: Round 3 undoes round 2");
  expect(codex.calls()).toEqual([expect.stringMatching(/^exec -m lookup-model -c model_reasoning_effort="low" -s read-only --ephemeral -C \S+ -o \S+ -$/)]);

  pr.env.FLEET_MODELS = JSON.stringify([]);
  await expect(pr.fleet("review-start", "--scope", "fixes", "--base", head)).rejects.toThrow("no lookup row");
});

test("an answer recorded on one round or PR cannot be reused on another", async () => {
  const pr = checkout();
  const head = pr.commit("feature.txt", "new\n");
  const answer = `2026-10-25 "Run one more round"`;
  pr.choose("Run one more round");
  await pr.fleet("review-start", "--scope", "full", "--override", answer, "--thread", "thread-1");
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  await pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md");
  pr.commit("feature.txt", "fixed\n");
  await expect(pr.fleet("review-start", "--scope", "fixes", "--base", head, "--override", answer, "--thread", "thread-1")).rejects.toThrow("already recorded on example/product#42 round 1");
  await expect(pr.fleet("review-start", "--scope", "fixes", "--base", head, "--override", `2026-10-25 "Run one more round" for round 2`, "--thread", "thread-1")).rejects.toThrow("already recorded on example/product#42 round 1");

  const accept = `2026-10-25 "Accept the gap"`;
  for (const kind of ["prod-shape", "cross-version"]) {
    await pr.fleet("gap", "--kind", kind, "--reason", "No sandbox");
    pr.chooseGap(kind, "No sandbox");
    expect((await pr.fleet("gap", "--kind", kind, "--accept", accept, "--thread", "thread-1")).code).toBe(0);
  }
  const otherPr = ["--repo", "example/product", "--pr", "43"];
  await pr.fleet("gap", ...otherPr, "--kind", "prod-shape", "--reason", "No sandbox");
  await expect(pr.fleet("gap", ...otherPr, "--kind", "prod-shape", "--accept", accept, "--thread", "thread-1")).rejects.toThrow("answers another question");
});

test("evidence counts at HEAD, across a clean base merge, or reused with a reason, and older evidence alone is missing", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  await pr.fleet("require", "--kinds", "live-run");
  writeFileSync(join(pr.repository, "run.log"), "GET /feature 200\n");
  await pr.fleet("save", "--kind", "live-run", "run.log");
  const proved = pr.git("rev-parse", "HEAD");
  pr.advanceBase("base.txt", "base\n");
  pr.git("merge", "-q", "--no-edit", "origin/main");

  expect((await pr.fleet("gate")).output).toContain(`live-run: evidence of ${proved.slice(0, 7)} carried across 1 clean merge(s) of the base`);

  pr.commit("feature.txt", "fixed\n");
  expect((await pr.fleet("gate")).output).toContain(`live-run: missing at HEAD; the newest evidence is at ${proved.slice(0, 7)}`);

  await pr.fleet("save", "--kind", "live-run", "--reuse-from", proved.slice(0, 8), "--reason", "the fix renames a local variable");
  expect((await pr.fleet("gate")).output).toContain(`live-run: evidence reused from ${proved.slice(0, 7)}: the fix renames a local variable`);
});

test("the gate reads CI on HEAD, and a ci gap stands in where CI cannot run", async () => {
  const pr = checkout();
  const head = pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "docs only");

  pr.ci([{ name: "test", bucket: "fail" }, { name: "lint", bucket: "pass" }]);
  const red = await pr.fleet("gate");
  expect(red.code).toBe(1);
  expect(red.output).toContain("ci: red, failing: test");

  pr.ci([{ name: "test", bucket: "pending" }]);
  expect((await pr.fleet("gate")).output).toContain("ci: pending");

  pr.ci([{ name: "test", bucket: "pass" }]);
  pr.githubHead("b".repeat(40));
  const unpushed = await pr.fleet("gate");
  expect(unpushed.code).toBe(1);
  expect(unpushed.output).toContain(`${head.slice(0, 7)} is not the PR's head on GitHub`);
  pr.githubHead(undefined);

  pr.ci("none");
  await pr.fleet("gap", "--kind", "ci", "--reason", "Fork CI cannot create its GitHub App token");
  expect((await pr.fleet("gate")).code).toBe(3);
  pr.chooseGap("ci", "Fork CI cannot create its GitHub App token");
  await pr.fleet("gap", "--kind", "ci", "--accept", `2026-10-25 "Accept the gap"`, "--thread", "thread-1");
  const accepted = await pr.fleet("gate");
  expect(accepted.code).toBe(0);
  expect(accepted.output.split("\n").at(-1)).toBe("gate: pass (kinds: none; review: round 1 by gpt-6.1-sol; CI: gap accepted; judge: pass by judge-under-test)");
});

test("require records the author family of the session, and refuses a family that contradicts it or changes", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");

  await expect(pr.fleet("require", "--none", "--reason", "docs only", "--author", "gpt")).rejects.toThrow("this session is claude");
  await pr.fleet("require", "--none", "--reason", "docs only");
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "required.json"), "utf8"))).toMatchObject({ author: "claude" });

  pr.env.CLAUDE_CODE_SESSION_ID = undefined;
  await expect(pr.fleet("require", "--repo", "example/product", "--pr", "43", "--kinds", "live-run")).rejects.toThrow("--author");
  await expect(pr.fleet("require", "--kinds", "live-run", "--author", "gpt")).rejects.toThrow("written by claude");
  expect((await pr.fleet("require", "--kinds", "live-run")).code).toBe(0);
});

test("one answer accepts the gap of the kind and PR its question names, however the agent words what it answers", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  pr.chooseGap("prod-shape", "No sandbox");
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No sandbox");
  expect((await pr.fleet("gap", "--kind", "prod-shape", "--accept", `2026-10-25 "Accept the gap" for PR 42`, "--thread", "thread-1")).code).toBe(0);
  const otherPr = ["--repo", "example/product", "--pr", "43"];
  await pr.fleet("gap", ...otherPr, "--kind", "prod-shape", "--reason", "No sandbox");
  await expect(pr.fleet("gap", ...otherPr, "--kind", "prod-shape", "--accept", `2026-10-25 "Accept the gap" for PR 43`, "--thread", "thread-1")).rejects.toThrow("answers another question");
});

test("a refusal never reads as an acceptance: the quote must be the user's whole message", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  pr.chooseGap("prod-shape", "No sandbox", "Do not accept the gap.");
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No sandbox");
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", `2026-10-25 "accept the gap."`, "--thread", "thread-1")).rejects.toThrow("Quote their whole message");
});

test("a standing rule the user narrows keeps only the kinds and the date its current command names", async () => {
  const pr = checkout();
  const rule = "I accept each owed Prod shape gap and decide nothing else.";
  const guide = (kinds: string, until: string) => writeFileSync(join(pr.home, ".agents/guides/standing-rules.md"), `- ${rule} \`fleet proof standing --kind ${kinds} --until ${until}\n  --rule "${rule}"\`\n`);
  guide("prod-shape,review", "2026-11-26");
  expect((await pr.fleet("standing", "--kind", "prod-shape,review", "--until", "2026-11-26", "--rule", rule)).code).toBe(0);
  expect(await standingFor(pr.home, "review", new Date("2026-11-10T12:00:00Z"))).toMatchObject({ until: "2026-11-26" });

  guide("prod-shape", "2026-11-05");
  expect(await standingFor(pr.home, "review", new Date("2026-11-04T12:00:00Z"))).toBeUndefined();
  expect(await standingFor(pr.home, "prod-shape", new Date("2026-11-04T12:00:00Z"))).toMatchObject({ kind: "prod-shape" });
  expect(await standingFor(pr.home, "prod-shape", new Date("2026-11-10T12:00:00Z"))).toBeUndefined();
});

test("reuse of reused evidence points at the commit that holds the files", async () => {
  const pr = checkout();
  const first = pr.commit("feature.txt", "new\n");
  writeFileSync(join(pr.repository, "run.log"), "GET /feature 200\n");
  await pr.fleet("save", "--kind", "live-run", "run.log");
  const second = pr.commit("feature.txt", "renamed\n");
  await pr.fleet("save", "--kind", "live-run", "--reuse-from", first, "--reason", "a rename");
  const third = pr.commit("feature.txt", "renamed again\n");
  expect((await pr.fleet("save", "--kind", "live-run", "--reuse-from", second, "--reason", "another rename")).code).toBe(0);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, `reused/live-run/${third}.json`), "utf8"))).toMatchObject({ from: first });
});

test("stray entries in reviews/ are ignored, and findings already in the round finish it", async () => {
  const pr = checkout();
  const head = pr.commit("feature.txt", "new\n");
  await pr.fleet("review-start", "--scope", "full");
  writeFileSync(join(pr.pullRequest, "reviews/notes.md"), "scratch\n");
  mkdirSync(join(pr.pullRequest, "reviews/briefs"));
  const findings = join(pr.pullRequest, "reviews/1/findings.md");
  writeFileSync(findings, "No findings.\n");

  expect((await pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", findings)).code).toBe(0);
  await pr.fleet("require", "--none", "--reason", "docs only");
  expect((await pr.fleet("gate")).code).toBe(0);

  pr.commit("feature.txt", "fixed\n");
  expect((await pr.fleet("review-start", "--scope", "final", "--base", head)).output).toContain(`"round":"final"`);
});

test("round 1 reviews the full diff and takes no base", async () => {
  const pr = checkout();
  const base = pr.commit("feature.txt", "new\n");
  pr.commit("feature.txt", "more\n");
  await expect(pr.fleet("review-start", "--scope", "fixes", "--base", base)).rejects.toThrow("Round 1 is --scope full");
  expect(existsSync(join(pr.pullRequest, "reviews/1"))).toBe(false);
});

test("the gate fails while a finding has no answer, and respond refuses answers that skip a finding", async () => {
  const pr = checkout();
  const head = pr.commit("feature.txt", "new\n");
  await pr.fleet("require", "--none", "--reason", "docs only");
  await pr.fleet("review-start", "--scope", "full");
  writeFileSync(join(pr.repository, "findings.md"), "- high, feature.txt:1, the greeting is wrong | anchor: new\n- low, feature.txt:1, a nit | anchor: new\n");
  await pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md");
  pr.commit("feature.txt", "fixed\n");
  await pr.fleet("review-start", "--scope", "fixes", "--base", head);
  await finishRound(pr, "2");

  const unanswered = await pr.fleet("gate");
  expect(unanswered.code).toBe(1);
  expect(unanswered.output).toContain("review: round 1 has unanswered findings 1, 2");
  expect(unanswered.output).toContain("review: round 2 has unanswered findings 1");

  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in 1a2b3c4: the greeting is right now.\n");
  await expect(pr.fleet("respond", "--round", "1", "responses.md")).rejects.toThrow("Answer findings 2");
  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in 1a2b3c4: the greeting is right now.\n2. rejected: the nit names a test fixture.\n");
  expect((await pr.fleet("respond", "--round", "1", "responses.md")).code).toBe(0);
  writeFileSync(join(pr.repository, "responses.md"), "1. Rejected: the finding repeats round 1.\n");
  await pr.fleet("respond", "--round", "2", "responses.md");
  expect((await pr.fleet("gate")).code).toBe(0);
});

test("an accepted ci gap never waives a commit that is not the PR's head on GitHub", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "docs only");
  pr.ci("none");
  await pr.fleet("gap", "--kind", "ci", "--reason", "Fork CI cannot create its GitHub App token");
  pr.chooseGap("ci", "Fork CI cannot create its GitHub App token");
  await pr.fleet("gap", "--kind", "ci", "--accept", `2026-10-25 "Accept the gap"`, "--thread", "thread-1");
  expect((await pr.fleet("gate")).code).toBe(0);

  pr.githubHead("b".repeat(40));
  const unpushed = await pr.fleet("gate");
  expect(unpushed.code).toBe(1);
  expect(unpushed.output).toContain("is not the PR's head on GitHub (bbbbbbb); push it");
});

test("the gate reads the checks and statuses of the commit itself, every page, and the PR head again before it passes", async () => {
  const pr = checkout();
  const head = pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  await pr.fleet("require", "--none", "--reason", "docs only");
  pr.ci("none");
  pr.ci([{ name: "test", bucket: "pass" }], "c".repeat(40));
  const elsewhere = await pr.fleet("gate");
  expect(elsewhere.code).toBe(1);
  expect(elsewhere.output).toContain("ci: none");
  expect(pr.githubCalls()).toContainEqual(expect.stringMatching(new RegExp(`^api --paginate repos/example/product/commits/${head}/check-runs`)));
  expect(pr.githubCalls()).toContainEqual(expect.stringMatching(new RegExp(`^api --paginate repos/example/product/commits/${head}/statuses`)));

  pr.ci([{ name: "test", bucket: "pass" }], head);
  pr.statuses([{ context: "deploy", state: "failure" }, { context: "deploy", state: "success" }], head);
  expect((await pr.fleet("gate")).output).toContain("ci: red, failing: deploy");
  pr.statuses([{ context: "deploy", state: "success" }, { context: "deploy", state: "failure" }], head);
  expect((await pr.fleet("gate")).code).toBe(0);

  pr.githubHead(undefined, "d".repeat(40));
  const moved = await pr.fleet("gate");
  expect(moved.code).toBe(1);
  expect(moved.output).toContain("head: the PR head moved to ddddddd while the gate read CI");
});

test("respond and review-finish take the id of the final read review-start printed, so a retry never lands on a later read", async () => {
  const pr = checkout();
  const reviewed = pr.commit("feature.txt", "new\n");
  await reviewHead(pr);
  pr.commit("feature.txt", "fix 1\n");
  const first = JSON.parse((await pr.fleet("review-start", "--scope", "final", "--base", reviewed)).output);
  expect(first).toMatchObject({ round: "final", id: "final-1" });
  writeFileSync(join(pr.repository, "findings.md"), "- low, feature.txt:1, a nit | anchor: fix 1\n");
  await expect(pr.fleet("review-finish", "--round", "final", "--reviewer", "gpt-6.1-sol", "findings.md")).rejects.toThrow("final-<n>");
  await pr.fleet("review-finish", "--round", "final-1", "--reviewer", "gpt-6.1-sol", "findings.md");
  const fixed = pr.git("rev-parse", "HEAD");
  pr.commit("feature.txt", "fix 2\n");
  expect(JSON.parse((await pr.fleet("review-start", "--scope", "final", "--base", fixed)).output)).toMatchObject({ id: "final-2" });

  writeFileSync(join(pr.repository, "responses.md"), "1. fixed in 1a2b3c4: the nit is gone.\n");
  expect((await pr.fleet("respond", "--round", "final-1", "responses.md")).output).toBe(join(pr.pullRequest, "reviews/final-1/responses.md"));
  expect(existsSync(join(pr.pullRequest, "reviews/final-2/responses.md"))).toBe(false);
});
