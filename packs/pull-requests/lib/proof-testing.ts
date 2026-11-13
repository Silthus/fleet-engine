import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv, template } from "../../../src/testing/git.ts";
import { spawnAsync } from "../../../src/testing/spawn.ts";
import { proofCommand, type ProofContext } from "./proof-cli.ts";
import type { ThreadWord, ThreadWords } from "./proof-answers.ts";
import { decisionCommand } from "./decision-cli.ts";
import type { Ssh, SshResult } from "./decision-ledger.ts";

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

const seedRepository = template(async (repository) => {
  const git = (...args: string[]) => spawnAsync(["git", ...args], { cwd: repository, env: gitEnv });
  writeFileSync(join(repository, "shared.txt"), "one\n");
  for (const args of [["init", "-q", "-b", "main"], ["remote", "add", "origin", "https://github.com/example/product.git"], ["add", "shared.txt"], ["commit", "-q", "-m", "Change shared.txt"], ["update-ref", "refs/remotes/origin/main", "HEAD"], ["checkout", "-q", "-b", "feature"]]) {
    const result = await git(...args);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
});

export async function checkout() {
  const directory = fixture("fleet-proof-checkout-");
  const [home, repository, bin, github] = ["home", "repository", "bin", "github"].map((name) => join(directory, name));
  for (const path of [home, bin, github]) mkdirSync(path);
  writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "${github}/calls"
if [ -f "${github}/head" ]; then read -r head < "${github}/head"
else
  read -r head < "${repository}/.git/HEAD"
  case "$head" in "ref: "*) ref="${repository}/.git/\${head#ref: }"; if [ -f "$ref" ]; then read -r head < "$ref"; else head=$(git -C "${repository}" rev-parse HEAD); fi;; esac
fi
base=main; [ -f "${github}/base" ] && read -r base < "${github}/base"
body='"Adds the greeting."'; [ -f "${github}/body" ] && body=$(cat "${github}/body")
case "$*" in
  "api "*"/pulls/"[0-9]*)
    [ -f "${github}/next-head" ] && mv "${github}/next-head" "${github}/head"
    draft=false; [ -f "${github}/draft" ] && draft=true
    printf '{"number":42,"title":"Greet new members","body":%s,"draft":%s,"head":{"sha":"%s"},"base":{"ref":"%s","repo":{"default_branch":"main"}}}\\n' "$body" "$draft" "$head" "$base"; exit 0;;
  "api "*"/rules/branches/"*)
    all="$*"; branch=\${all##*/rules/branches/}; page=\${all##*page=}; branch=\${branch%%\\?*}
    [ -f "${github}/rules-error-$branch" ] && { cat "${github}/rules-error-$branch" >&2; exit 1; }
    cat "${github}/rules-$branch-$page" 2>/dev/null || echo '[]'; exit 0;;
  "api "*"/branches/"*)
    all="$*"; branch=\${all##*/branches/}; branch=\${branch%% *}
    cat "${github}/branch-$branch" 2>/dev/null || echo '{"protected":false}'; exit 0;;
  "api "*)
    all="$*"; sha=; case "$all" in */commits/*/*) sha=\${all#*/commits/}; sha=\${sha%%/*};; esac
    case "$*" in *"/check-runs"*) kind=check-runs;; *) kind=statuses;; esac
    file="${github}/$kind-$sha"; [ -f "$file" ] || file="${github}/$kind-any"
    cat "$file" 2>/dev/null; exit 0;;
esac
printf '{"number":42,"url":"https://github.com/example/product/pull/42","baseRefName":"%s","headRefOid":"%s","title":"Greet new members","body":%s}\\n' "$base" "$head" "$body"
`, { mode: 0o755 });
  for (const model of ["claude", "codex"]) writeFileSync(join(bin, model), `#!/bin/sh\necho "the test ran the real ${model}" >&2\nexit 97\n`, { mode: 0o755 });
  const runs: Record<string, { status: string; conclusion: string | null }> = { pass: { status: "completed", conclusion: "success" }, fail: { status: "completed", conclusion: "failure" }, cancel: { status: "completed", conclusion: "cancelled" }, pending: { status: "in_progress", conclusion: null } };
  const lines = (items: object[]) => items.map((item) => JSON.stringify(item) + "\n").join("");
  const ci = (checks: { name: string; bucket: string; app?: number }[] | "none", commit = "any") => writeFileSync(join(github, `check-runs-${commit}`), checks === "none" ? "" : lines(checks.map(({ name, bucket, app = 1 }, index) => ({ id: index + 1, name, ...runs[bucket], app }))));
  const required = (branch: string, rules: { context: string; integration_id?: number }[] | { error: string }, { classic, page = 1, others = 0 }: { classic?: string[]; page?: number; others?: number } = {}) => {
    rmSync(join(github, `rules-error-${branch}`), { force: true });
    if ("error" in rules) writeFileSync(join(github, `rules-error-${branch}`), rules.error);
    else writeFileSync(join(github, `rules-${branch}-${page}`), JSON.stringify([...Array.from({ length: others }, () => ({ type: "deletion" })), ...(rules.length ? [{ type: "required_status_checks", parameters: { required_status_checks: rules } }] : [])]));
    if (classic) writeFileSync(join(github, `branch-${branch}`), JSON.stringify({ protected: true, protection: { required_status_checks: { enforcement_level: "everyone", contexts: classic, checks: classic.map((context) => ({ context, app_id: null })) } } }));
  };
  const pullRequestState = ({ draft, base, body }: { draft?: boolean; base?: string; body?: string }) => {
    if (body !== undefined) writeFileSync(join(github, "body"), JSON.stringify(body));
    if (draft !== undefined) { if (draft) writeFileSync(join(github, "draft"), ""); else rmSync(join(github, "draft"), { force: true }); }
    if (base !== undefined) writeFileSync(join(github, "base"), base);
  };
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
    FLEET_PROOF_JUDGE: `cat >/dev/null; echo '${verdict()}'`, FLEET_PROOF_JUDGE_MODEL: "judge-under-test", T3CODE_THREAD_ID: "thread-1",
  };
  const git = async (...args: string[]) => {
    const result = await spawnAsync(["git", ...args], { cwd: repository, env });
    if (result.exitCode !== 0 && args[0] !== "merge") throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = async (file: string, content: string) => {
    writeFileSync(join(repository, file), content);
    await git("add", file);
    await git("commit", "-q", "-m", `Change ${file}`);
    return git("rev-parse", "HEAD");
  };
  const advanceBase = async (file: string, content: string) => {
    await git("checkout", "-q", "main");
    await commit(file, content);
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "-q", "feature");
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
  const hub: { ssh?: Ssh } = {};
  const panel: { lostWorkers: boolean; onPause?: () => Promise<void>; beforeWorker?: () => Promise<void> } = { lostWorkers: false };
  const startTimes = new Map<number, string>();
  const fleetAt = async (cwd: string, pid: number, args: string[]) => {
    const lines: string[] = [];
    const context: ProofContext = {
      home, cwd, env, pid, print: (line) => lines.push(line), now: () => clock.now, threadWords: reader.words, ssh: hub.ssh,
      startTime: async (holder) => startTimes.get(holder) ?? "Sun Oct 25 11:00:00 2026",
      detach: async (worker) => {
        if (panel.lostWorkers) return exitedPid();
        await panel.beforeWorker?.();
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
  const fleetIn = (cwd: string, ...args: string[]) => fleetAt(cwd, process.pid, args);
  const fleet = (...args: string[]) => fleetIn(repository, ...args);
  const fleetAs = (pid: number, ...args: string[]) => fleetAt(repository, pid, args);
  const decide = async (...args: string[]) => {
    const lines: string[] = [];
    const code = await decisionCommand(args, { home, cwd: repository, env, print: (line) => lines.push(line), now: () => clock.now, threadWords: reader.words, ssh: hub.ssh });
    return { code, output: lines.join("\n") };
  };
  const pullRequest = join(home, ".local/state/fleet/proof/example/product/42");
  await seedRepository(repository);
  return { home, repository, pullRequest, env, git, commit, advanceBase, fleet, fleetIn, fleetAs, ci, statuses, required, pullRequestState, githubHead, githubCalls, clock, say, choose, chooseGap, reader, panel, hub, decide, startTimes };
}

export type Checkout = Awaited<ReturnType<typeof checkout>>;

export const exitedPid = async () => (await spawnAsync(["true"])).pid;

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

export function verdict(changes: { proof?: Question; owed?: Question; review?: Question; risk?: Question; quality?: Quality } = {}) {
  const pass = (reason: string): Question => ({ verdict: "pass", reason, citations: [] });
  return JSON.stringify({
    proof: pass("The evidence shows HEAD working"), owed: pass("The owed kinds fit the diff"), review: pass("Every finding is answered"),
    quality: { reason: "The code follows the rubric", citations: [], findings: [] }, ...changes,
  });
}

export function fakeModel(pr: Checkout, role: "REVIEWER" | "JUDGE", answer: string) {
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

export async function reviewHead(pr: Checkout) {
  expect((await pr.fleet("review-start", "--scope", "full")).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), "No findings.\n");
  expect((await pr.fleet("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  markPanel(pr, "1");
  return pr.git("rev-parse", "HEAD");
}

export const markPanel = (pr: Checkout, round: string) => writeFileSync(join(pr.pullRequest, "reviews", round, "panel.json"), JSON.stringify({ lenses: [], changedFiles: [], cwd: pr.repository, readable: [] }));

export const ledgerDecisions = (pr: Checkout) => {
  const path = join(pr.home, ".local/state/fleet/decisions.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).decision).filter(Boolean) : [];
};

type Hub = "up" | "down" | "drops appends" | "loses the acknowledgement of appends" | "stalls on appends" | "stalls after it lands an append";
const refused = { code: 255, stdout: "", stderr: "ssh: connect to host fleet-hub port 22: Connection refused\n" };

export function hubAt(pr: Checkout, hub: Hub | boolean = "up") {
  const remote = join(pr.home, "hub-home");
  const hosts: string[] = [];
  const state: { hub: Hub; afterAppend?: () => void } = { hub: hub === true ? "up" : hub === false ? "down" : hub };
  let stalled = () => {};
  const appendStalled = new Promise<void>((resolve) => { stalled = resolve; });
  const stalls: ((result: SshResult) => void)[] = [];
  const stall = () => { stalled(); return new Promise<SshResult>((resolve) => stalls.push(resolve)); };
  const releaseAppends = () => stalls.splice(0).forEach((resolve) => resolve(refused));
  pr.env.FLEET_SETTINGS = JSON.stringify({ ...settings, "hub.alias": "fleet-hub" });
  pr.hub.ssh = async (host, command, stdin) => {
    hosts.push(host);
    if (state.hub === "down") return refused;
    if (state.hub === "drops appends" && stdin !== undefined) return { code: 0, stdout: "", stderr: "" };
    if (state.hub === "stalls on appends" && stdin !== undefined) return stall();
    const child = Bun.spawn(["bash", "-c", command], { env: { HOME: remote, PATH: process.env.PATH }, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (stdin !== undefined) state.afterAppend?.();
    if (state.hub === "stalls after it lands an append" && stdin !== undefined) return stall();
    if (state.hub === "loses the acknowledgement of appends" && stdin !== undefined) return refused;
    return { code, stdout, stderr };
  };
  return { remote, hosts, state, appendStalled, releaseAppends };
}

export const acceptGap = (pr: Checkout, kind: string, ...more: string[]) => pr.decide("record", "--mark", "👤", "--class", "proof-gap", "--kind", kind, "--pr", "example/product#42", ...more);

export const graded = (tier: string) => `## Merge risk\n\n<!-- merge-risk -->\n> [!NOTE]\n> 🔵 **Merge risk: low** · two-way door\n> - **Tier:** ${tier}\n<!-- /merge-risk -->\n`;

export async function finishRound(pr: Checkout, round: string) {
  writeFileSync(join(pr.repository, "findings.md"), `Findings of ${round}.\n`);
  await pr.fleet("review-finish", "--round", round, "--reviewer", "gpt-6.1-sol", "findings.md");
}

export function recordingModel(pr: Checkout, provider: "claude" | "codex", answer: string) {
  const calls = join(pr.home, `${provider}-calls`);
  const reply = provider === "claude" ? `echo '${answer}'` : `for arg in "$@"; do [ "$previous" = "-o" ] && echo '${answer}' > "$arg"; previous="$arg"; done`;
  writeFileSync(join(pr.env.PATH!.split(":")[0]!, provider), `#!/bin/sh\necho "$*" >> "${calls}"\ncat > "${calls}-prompt"\n${reply}\n`, { mode: 0o755 });
  return { calls: () => readFileSync(calls, "utf8").trim().split("\n"), prompt: () => readFileSync(`${calls}-prompt`, "utf8") };
}

export const stalledOnQuota = (first = "ERROR: Reconnecting... 1/5", second = first.replace("1/5", "2/5")) =>
  `cat >/dev/null; printf 'codex\\nreading the diff\\n%s\\n%s\\n' '${first}' '${second}' >&2; exec tail -f /dev/null`;

export const blanks = (stream: 1 | 2) => `head -c 200000 /dev/zero | tr '\\0' ' ' >&${stream}`;
