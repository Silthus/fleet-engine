import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../../../src/testing/git.ts";
import { proofCommand, type ProofContext } from "./proof-cli.ts";
import type { ThreadWord, ThreadWords } from "./proof-answers.ts";

const fixtures: string[] = [];
export const cleanFixtures = () => fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));

export function fixture(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(directory);
  return directory;
}

export const settings = { "pull-requests.freeReviews": 2, "pull-requests.reviewCeiling": 6, "pull-requests.reviewTimeoutMinutes": 20, "pull-requests.panelSlots": 3 };
export const lookup = { role: "lookup", work: "Find files", provider: "claude", model: "lookup-model", effort: "medium" };
export const models = [lookup, { role: "review", work: "Review Claude's code", provider: "codex", model: "review-model", effort: "high" }, { role: "review-codex", work: "Review Codex's code", provider: "claude", model: "review-codex-model", effort: "high" }];

export const rubric = "# Coding standards\n\n- Keep things simple.";

export function checkout() {
  const directory = fixture("fleet-proof-checkout-");
  const [home, repository, bin, github] = ["home", "repository", "bin", "github"].map((name) => join(directory, name));
  for (const path of [home, repository, bin, github]) mkdirSync(path);
  writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "${github}/calls"
case "$*" in "api "*)
  sha=$(printf '%s' "$*" | sed -n 's#.*/commits/\\([0-9a-f]*\\)/.*#\\1#p')
  case "$*" in *"/check-runs"*) kind=check-runs;; *) kind=statuses;; esac
  file="${github}/$kind-$sha"; [ -f "$file" ] || file="${github}/$kind-any"
  cat "$file" 2>/dev/null; exit 0;;
esac
head=$(cat "${github}/head" 2>/dev/null || git -C "${repository}" rev-parse HEAD)
case "$*" in *headRefOid*) [ -f "${github}/next-head" ] && mv "${github}/next-head" "${github}/head";; esac
printf '{"number":42,"url":"https://github.com/example/product/pull/42","baseRefName":"main","headRefOid":"%s","title":"Greet new members","body":"Adds the greeting."}\\n' "$head"
`, { mode: 0o755 });
  for (const model of ["claude", "codex"]) writeFileSync(join(bin, model), `#!/bin/sh\necho "the test ran the real ${model}" >&2\nexit 97\n`, { mode: 0o755 });
  const runs: Record<string, { status: string; conclusion: string | null }> = { pass: { status: "completed", conclusion: "success" }, fail: { status: "completed", conclusion: "failure" }, cancel: { status: "completed", conclusion: "cancelled" }, pending: { status: "in_progress", conclusion: null } };
  const lines = (items: object[]) => items.map((item) => JSON.stringify(item) + "\n").join("");
  const ci = (checks: { name: string; bucket: string }[] | "none", commit = "any") => writeFileSync(join(github, `check-runs-${commit}`), checks === "none" ? "" : lines(checks.map(({ name, bucket }) => ({ name, ...runs[bucket] }))));
  const statuses = (list: { context: string; state: string }[], commit = "any") => writeFileSync(join(github, `statuses-${commit}`), lines(list));
  const githubHead = (commit: string | undefined, next?: string) => {
    if (commit) writeFileSync(join(github, "head"), commit); else rmSync(join(github, "head"), { force: true });
    if (next) writeFileSync(join(github, "next-head"), next);
  };
  const githubCalls = () => readFileSync(join(github, "calls"), "utf8").trim().split("\n");
  ci([{ name: "test", bucket: "pass" }]);
  mkdirSync(join(home, ".agents/guides"), { recursive: true });
  writeFileSync(join(home, ".agents/guides/coding-standards.md"), rubric);
  mkdirSync(join(home, ".agents/skills/qa-swarm"), { recursive: true });
  writeFileSync(join(home, ".agents/skills/qa-swarm/PANEL.md"), panelGuide);
  const clock = { now: new Date("2026-10-25T12:00:00Z") };
  const env: Record<string, string | undefined> = {
    ...gitEnv, PATH: `${bin}:${process.env.PATH}`,
    CLAUDE_CODE_SESSION_ID: "session-under-test", CODEX_THREAD_ID: undefined, FLEET_SETTINGS: JSON.stringify(settings), FLEET_MODELS: JSON.stringify(models),
    FLEET_PROOF_JUDGE: `cat >/dev/null; echo '${verdict()}'`, FLEET_PROOF_JUDGE_MODEL: "judge-under-test",
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repository, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0 && args[0] !== "merge") throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.toString().trim();
  };
  const commit = (file: string, content: string) => {
    writeFileSync(join(repository, file), content);
    git("add", file);
    git("commit", "-q", "-m", `Change ${file}`);
    return git("rev-parse", "HEAD");
  };
  const advanceBase = (file: string, content: string) => {
    git("checkout", "-q", "main");
    commit(file, content);
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "feature");
  };
  const words: ThreadWord[] = [];
  const thread = "mcp:thread-1";
  const say = (text: string, answered = "Shall I run one more round?", id = `message-${words.length + 1}`) => words.push({ thread, id, text, answered, at: clock.now.toISOString(), source: "typed" });
  const choose = (option: string, question = "Run one more review round? example/product#42: the arbiter escalates.") => words.push({ thread, id: `request-${words.length + 1}:0`, text: option, answered: question, at: clock.now.toISOString(), source: "question" });
  const chooseGap = (kind: string, reason: string, option = "Accept the gap", number = 42) => choose(option, `Accept the ${kind} gap? example/product#${number}: ${reason}`);
  const threadWords = async (name: string) => {
    if (name !== "thread-1" && name !== thread) throw new Error(`No thread ${name}`);
    return words;
  };
  const reader: { words?: ThreadWords } = { words: threadWords };
  const panel: { lostWorkers: boolean; onPause?: () => Promise<void> } = { lostWorkers: false };
  const fleetIn = async (cwd: string, ...args: string[]) => {
    const lines: string[] = [];
    const context: ProofContext = {
      home, cwd, env, print: (line) => lines.push(line), now: () => clock.now, threadWords: reader.words,
      detach: async (worker) => {
        if (panel.lostWorkers) return Bun.spawnSync(["true"]).pid;
        await proofCommand([...worker], { ...context, print: () => {} });
        return process.pid;
      },
      pause: async () => {
        if (!panel.onPause) throw new Error("The test did not expect a wait");
        await panel.onPause();
      },
    };
    const code = await proofCommand(args, context);
    return { code, output: lines.join("\n") };
  };
  const fleet = (...args: string[]) => fleetIn(repository, ...args);
  const pullRequest = join(home, ".local/state/fleet/proof/example/product/42");
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/example/product.git");
  commit("shared.txt", "one\n");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "feature");
  return { home, repository, pullRequest, env, git, commit, advanceBase, fleet, fleetIn, ci, statuses, githubHead, githubCalls, clock, say, choose, chooseGap, reader, panel };
}

export const panelGuide = `# QA swarm panel

- **Review lane**: the other family. It runs Correctness, Risk, Design, and
  Systems.
- **Fresh-eyes lane**: the author's family. It runs Fresh eyes and UI, with UI
  cast by the policy.

## Brief

\`\`\`md
You review a pull request. Goal: <goal>
Base: origin/<base>. Head: <sha>.

<output of git diff origin/<base>...<sha>>

Settled: <ledger entries that are fixed, rejected, or decided>.

Context (every lens except Design and Anti-Overengineering):
PR description: <current body, without its merge-risk callout>
Owed proofs: <the owed kinds>

Lens: <lens name and hunting grounds>

<the repo knowledge for this lens, or nothing>

FINDINGS:
- <file>:<line> | <severity>
COVERED: <every changed file>
\`\`\`

## Lenses

### Fresh eyes

Read it as a senior engineer who sees it for the first time.

### Correctness

Trace one concrete input through each new branch.

### Design

Find the code judo move.

### Team

One lens per perspective of the owners.

### Sweep

Find what the other lenses missed.
`;

export const clean = "FINDINGS:\n(none)\nCOVERED: feature.txt\n";

export type Question = { verdict: "pass" | "fail"; reason: string; citations: string[] };
export type Quality = { reason: string; citations: string[]; findings: { rating: "high" | "medium" | "low"; problem: string; citation: string }[] };

export function verdict(changes: { proof?: Question; owed?: Question; review?: Question; quality?: Quality } = {}) {
  const pass = (reason: string): Question => ({ verdict: "pass", reason, citations: [] });
  return JSON.stringify({
    proof: pass("The evidence shows HEAD working"), owed: pass("The owed kinds fit the diff"), review: pass("Every finding is answered"),
    quality: { reason: "The code follows the rubric", citations: [], findings: [] }, ...changes,
  });
}

export function fakeModel(pr: ReturnType<typeof checkout>, role: "REVIEWER" | "JUDGE", answer: string) {
  const prompts = join(pr.home, `${role.toLowerCase()}-prompts`);
  mkdirSync(prompts, { recursive: true });
  const reply = join(pr.home, `${role.toLowerCase()}-answer`);
  writeFileSync(reply, answer);
  pr.env[`FLEET_PROOF_${role}`] = `cat > "${prompts}/$(date +%s%N).txt"; cat "${reply}"`;
  return {
    answer: (text: string) => writeFileSync(reply, text),
    prompts: () => readdirSync(prompts).sort().map((name) => readFileSync(join(prompts, name), "utf8")),
  };
}

export async function reviewHead(pr: ReturnType<typeof checkout>) {
  expect((await pr.fleet("review-start", "--scope", "full")).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  return pr.git("rev-parse", "HEAD");
}

export const decideRule = "Until 2026-11-26, decide review rounds, judge gaps, and post-deploy-watch gaps yourself.";

export function withDecideRule(pr: ReturnType<typeof checkout>) {
  const record = (kinds: string) => `\`fleet proof standing --kind ${kinds} --until 2026-11-26 --rule "${decideRule}"\``;
  writeFileSync(join(pr.home, ".agents/AGENTS.md"), `# Agents\n\n## Skill settings\n\n- ${decideRule} Record it with ${record("review,judge,post-deploy-watch")}, ${record("review")}, or ${record("judge")}.\n`);
}

export async function finishRound(pr: ReturnType<typeof checkout>, round: string) {
  writeFileSync(join(pr.repository, "findings.md"), `Findings of ${round}.\n`);
  await pr.fleet("review-finish", "--round", round, "--reviewer", "gpt-6.1-sol", "findings.md");
}

export function recordingModel(pr: ReturnType<typeof checkout>, provider: "claude" | "codex", answer: string) {
  const calls = join(pr.home, `${provider}-calls`);
  const reply = provider === "claude" ? `echo '${answer}'` : `for arg in "$@"; do [ "$previous" = "-o" ] && echo '${answer}' > "$arg"; previous="$arg"; done`;
  writeFileSync(join(pr.env.PATH!.split(":")[0]!, provider), `#!/bin/sh\necho "$*" >> "${calls}"\ncat > "${calls}-prompt"\n${reply}\n`, { mode: 0o755 });
  return { calls: () => readFileSync(calls, "utf8").trim().split("\n"), prompt: () => readFileSync(`${calls}-prompt`, "utf8") };
}
