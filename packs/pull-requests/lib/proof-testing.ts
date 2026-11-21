import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

export const settings = { "pull-requests.receiptHeading": "Testing", "pull-requests.freeReviews": 2, "pull-requests.reviewCeiling": 6, "pull-requests.reviewTimeoutMinutes": 20, "pull-requests.panelSlots": 3 };
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

export async function checkout(prefix = "hedge-proof-checkout-") {
  const directory = fixture(prefix);
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
if [ -f "${github}/base-sha" ]; then read -r basesha < "${github}/base-sha"; else basesha=\\"$(git -C "${repository}" rev-parse refs/remotes/origin/main 2>/dev/null)\\"; fi
body='"Adds the greeting. Merge risk: medium."'; [ -f "${github}/body" ] && body=$(cat "${github}/body")
case "$*" in
  "api "*"/pulls/"[0-9]*" --method PATCH --input "*)
    [ -f "${github}/patch-error" ] && { cat "${github}/patch-error" >&2; exit 1; }
    all="$*"; n=\${all##*/pulls/}; n=\${n%%[!0-9]*}; target="${github}/body"; [ -f "${github}/body-$n" ] && target="${github}/body-$n"
    "${process.execPath}" -e 'const [input, target, mangle] = process.argv.slice(1); const fs = require("fs"); const body = JSON.parse(fs.readFileSync(input, "utf8")).body; fs.writeFileSync(target, JSON.stringify(fs.existsSync(mangle) ? body + fs.readFileSync(mangle, "utf8") : body));' "\${all##* }" "$target" "${github}/patch-mangle"
    echo '{}'; exit 0;;
  "api "*"/pulls/"[0-9]*)
    [ -f "${github}/next-head" ] && mv "${github}/next-head" "${github}/head"
    [ -f "${github}/while-reading" ] && { mv "${github}/while-reading" "${github}/while-reading.sh"; sh "${github}/while-reading.sh"; }
    draft=false; [ -f "${github}/draft" ] && draft=true
    all="$*"; n=\${all##*/pulls/}; n=\${n%%[!0-9]*}
    [ -f "${github}/pull-error-$n" ] && { cat "${github}/pull-error-$n" >&2; exit 1; }
    [ -f "${github}/body-$n" ] && body=$(cat "${github}/body-$n")
    state=open; merged=null; [ -f "${github}/merged-$n" ] && { state=closed; merged='"2026-10-25T09:00:00Z"'; }; [ -f "${github}/closed-$n" ] && state=closed
    printf '{"number":%s,"title":"Greet new members","body":%s,"draft":%s,"state":"%s","merged_at":%s,"head":{"sha":"%s"},"base":{"ref":"%s","sha":%s,"repo":{"default_branch":"main"}}}\\n' "$n" "$body" "$draft" "$state" "$merged" "$head" "$base" "$basesha"; exit 0;;
  "api "*"/rules/branches/"*)
    all="$*"; branch=\${all##*/rules/branches/}; page=\${all##*page=}; branch=\${branch%%\\?*}
    [ -f "${github}/rules-error-$branch" ] && { cat "${github}/rules-error-$branch" >&2; exit 1; }
    cat "${github}/rules-$branch-$page" 2>/dev/null || echo '[]'; exit 0;;
  "api user")
    printf '{"login":"%s"}\\n' "$(cat "${github}/user" 2>/dev/null || echo the-user)"; exit 0;;
  "api "*"/issues/comments/"*)
    all="$*"; id=\${all##*/issues/comments/}
    [ -f "${github}/comment-$id" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    cat "${github}/comment-$id"; exit 0;;
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
  const pullRequestState = ({ draft, base, baseSha, body, number, merged, closed, unreadable }: { draft?: boolean; base?: string; baseSha?: string | number; body?: string; number?: number; merged?: boolean; closed?: boolean; unreadable?: string }) => {
    if (unreadable !== undefined) writeFileSync(join(github, `pull-error-${number ?? 42}`), unreadable);
    if (body !== undefined) writeFileSync(join(github, number === undefined ? "body" : `body-${number}`), JSON.stringify(body));
    if (merged) writeFileSync(join(github, `merged-${number ?? 42}`), "");
    if (closed) writeFileSync(join(github, `closed-${number ?? 42}`), "");
    if (draft !== undefined) { if (draft) writeFileSync(join(github, "draft"), ""); else rmSync(join(github, "draft"), { force: true }); }
    if (base !== undefined) writeFileSync(join(github, "base"), base);
    if (baseSha !== undefined) writeFileSync(join(github, "base-sha"), JSON.stringify(baseSha));
  };
  const statuses = (list: { context: string; state: string }[], commit = "any") => writeFileSync(join(github, `statuses-${commit}`), lines(list));
  const githubHead = (commit: string | undefined, next?: string) => {
    if (commit) writeFileSync(join(github, "head"), commit); else rmSync(join(github, "head"), { force: true });
    if (next) writeFileSync(join(github, "next-head"), next);
  };
  const whileGithubReadsPull = (script: string) => writeFileSync(join(github, "while-reading"), script);
  const githubComment = (id: number, author: string, body: string, createdAt = "2026-10-25T11:00:00Z", on = 42) => writeFileSync(join(github, `comment-${id}`), JSON.stringify({ user: { login: author }, body, created_at: createdAt, issue_url: `https://api.github.com/repos/example/product/issues/${on}` }));
  const githubBody = (number = 42) => JSON.parse(readFileSync(join(github, existsSync(join(github, `body-${number}`)) ? `body-${number}` : "body"), "utf8")) as string;
  const githubFault = (fault: "patch-error" | "patch-mangle", text: string | undefined) => text === undefined ? rmSync(join(github, fault), { force: true }) : writeFileSync(join(github, fault), text);
  const githubCalls = () => readFileSync(join(github, "calls"), "utf8").trim().split("\n");
  ci([{ name: "test", bucket: "pass" }]);
  mkdirSync(join(home, ".agents/guides"), { recursive: true });
  writeFileSync(join(home, ".agents/guides/coding-standards.md"), rubric);
  mkdirSync(join(home, ".agents/skills/qa-swarm"), { recursive: true });
  writeFileSync(join(home, ".agents/skills/qa-swarm/PANEL.md"), panelGuide);
  const clock = { now: new Date("2026-10-25T12:00:00Z") };
  const env: Record<string, string | undefined> = {
    ...gitEnv, PATH: `${bin}:${process.env.PATH}`,
    CLAUDE_CODE_SESSION_ID: "session-under-test", CODEX_THREAD_ID: undefined, HEDGE_SETTINGS: JSON.stringify(settings), HEDGE_MODELS: JSON.stringify(models),
    HEDGE_PROOF_JUDGE: `cat >/dev/null; echo '${verdict()}'`, HEDGE_PROOF_JUDGE_MODEL: "judge-under-test", HEDGE_PROOF_BLOAT_JUDGE: `cat >/dev/null; echo '{"cuttable":0,"hunks":[]}'`, HEDGE_PROOF_BLOAT_JUDGE_MODEL: "bloat-judge-under-test", T3CODE_THREAD_ID: "thread-1", HEDGE_PROOF_RETRY_DELAY_MS: "0",
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
  const pendingCards = new Set<string>();
  const panel: { lostWorkers: boolean; onPause?: (ms?: number) => Promise<void>; beforeWorker?: () => Promise<void> } = { lostWorkers: false };
  const startTimes = new Map<number, string>();
  const hedgeAt = async (cwd: string, pid: number, args: string[]) => {
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
      pause: async (ms) => {
        if (!panel.onPause) throw new Error("The test did not expect a wait");
        await panel.onPause(ms);
      },
    };
    const code = await proofCommand(args, context);
    return { code, output: lines.join("\n") };
  };
  const hedgeIn = (cwd: string, ...args: string[]) => hedgeAt(cwd, process.pid, args);
  const hedge = (...args: string[]) => hedgeIn(repository, ...args);
  const hedgeAs = (pid: number, ...args: string[]) => hedgeAt(repository, pid, args);
  const decideIn = async (cwd: string, ...args: string[]) => {
    const lines: string[] = [];
    const code = await decisionCommand(args, { home, cwd, env, print: (line) => lines.push(line), now: () => clock.now, threadWords: reader.words, ssh: hub.ssh, pendingCard: async (thread) => pendingCards.has(thread) });
    return { code, output: lines.join("\n") };
  };
  const decide = (...args: string[]) => decideIn(repository, ...args);
  const pullRequest = join(home, ".local/state/hedge/proof/example/product/42");
  await seedRepository(repository);
  return { home, repository, pullRequest, env, git, commit, advanceBase, hedge, hedgeIn, hedgeAs, ci, statuses, required, pullRequestState, githubHead, githubCalls, githubBody, githubFault, githubComment, whileGithubReadsPull, clock, say, choose, chooseGap, reader, panel, hub, pendingCards, decide, decideIn, startTimes };
}

export type Checkout = Awaited<ReturnType<typeof checkout>>;

export const exitedPid = async () => (await spawnAsync(["true"])).pid;

const panelModule = JSON.stringify(join(import.meta.dir, "proof-panel.ts"));

const lockHolderScript = `import { roundLock, withRoundLock } from ${panelModule};
const owner = { pid: process.pid, now: () => new Date(), startTime: async () => "Sun Oct 25 11:00:00 2026" };
await withRoundLock(process.argv[2]!, await roundLock(owner), async () => { console.log("held"); await Bun.stdin.text(); });
`;

const reviewerSlotScript = `import { withSlot } from ${panelModule};
const io = { pid: process.pid, now: () => new Date(), startTime: async () => "Sun Oct 25 11:00:00 2026", env: {}, pause: async () => {}, slots: process.argv[2]!, slotCount: 1, limit: 1 };
await withSlot(io, async ({ recordReviewer }) => { await recordReviewer(Number(process.argv[3])); console.log("held"); await Bun.stdin.text(); });
`;

const takeoverScript = `import { roundLock, withRoundLock } from ${panelModule};
const owner = { pid: process.pid, now: () => new Date(), startTime: async (pid: number) => {
  if (pid === process.pid) return "Sun Oct 25 11:00:00 2026";
  console.log("held");
  await Bun.stdin.text();
  return undefined;
} };
await withRoundLock(process.argv[2]!, await roundLock(owner), async () => {});
`;

async function holding(name: string, source: string, args: string[]) {
  const script = join(fixture(`hedge-${name}-`), "hold.ts");
  writeFileSync(script, source);
  const child = Bun.spawn([process.execPath, script, ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let said = "";
  while (!said.includes("held")) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`The ${name} exited with ${await child.exited} before it held ${args[0]}`);
    said += new TextDecoder().decode(value);
  }
  return {
    pid: child.pid,
    release: async () => { child.stdin.end(); return child.exited; },
    crash: async () => { child.kill("SIGKILL"); await child.exited; },
  };
}

export const lockHolder = (directory: string) => holding("lock-holder", lockHolderScript, [directory]);

/** Leaves the round lock of the directory stuck: a crashed holder that recorded a reviewer, and takeovers of it that crashed while they stopped that reviewer. */
export async function stuckRoundLock(directory: string, takeovers: number) {
  const slots = fixture("hedge-reviewer-slots-");
  await (await holding("reviewer slot holder", reviewerSlotScript, [slots, String(await exitedPid())])).crash();
  renameSync(join(slots, readdirSync(slots)[0]!), join(directory, "round.lock"));
  for (let takeover = 0; takeover < takeovers; takeover++) await (await holding("takeover", takeoverScript, [directory])).crash();
}

export const panelGuide = `# QA swarm panel

- **Review lane**: the other family. It runs Correctness, Risk, Design, and
  Systems.
- **Fresh-eyes lane**: the author's family. It runs Fresh eyes and UI, with UI
  cast by the policy.
- **Security lane**: the policy's Deep security review model. It runs Security,
  and only on a diff in a security area.

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

### Risk

Weigh the blast radius of each changed path.

### Design

Find the code judo move.

### Anti-Overengineering

Name the code the change does not need.

### Team

One lens per perspective of the owners.

### Security

Hunt for exploit chains.

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

export function fakeModel(pr: Checkout, role: "REVIEWER" | "JUDGE" | "BLOAT_JUDGE", answer: string) {
  const prompts = join(pr.home, `${role.toLowerCase()}-prompts`);
  mkdirSync(prompts, { recursive: true });
  const reply = join(pr.home, `${role.toLowerCase()}-answer`);
  writeFileSync(reply, answer);
  pr.env[`HEDGE_PROOF_${role}`] = `cat > "${prompts}/$(date +%s%N).txt"; cat "${reply}"`;
  return {
    answer: (text: string) => writeFileSync(reply, text),
    prompts: () => readdirSync(prompts).sort().map((name) => readFileSync(join(prompts, name), "utf8")),
  };
}

export async function reviewHead(pr: Checkout, findings = "No findings.\n") {
  expect((await pr.hedge("review-start", "--scope", "full")).code).toBe(0);
  writeFileSync(join(pr.repository, "findings.md"), findings);
  expect((await pr.hedge("review-finish", "--round", "1", "--reviewer", "gpt-6.1-sol", "findings.md")).code).toBe(0);
  markPanel(pr, "1");
  return pr.git("rev-parse", "HEAD");
}

export const productionMajor = (location: string, anchor: string) => `- major | ${location} | the change drops a case | anchor: ${anchor}\n`;

export async function answerFixed(pr: Checkout, round: string, findings = 1) {
  writeFileSync(join(pr.repository, "responses.md"), Array.from({ length: findings }, (_, index) => `${index + 1}. fixed: the change keeps the case\n`).join(""));
  expect((await pr.hedge("respond", "--round", round, "responses.md")).code).toBe(0);
}

export async function reviewHeadFixed(pr: Checkout, location: string, anchor: string) {
  const head = await reviewHead(pr, productionMajor(location, anchor));
  await answerFixed(pr, "1");
  return head;
}

export function markPanel(pr: Checkout, round: string) {
  const directory = join(pr.pullRequest, "reviews", round);
  mkdirSync(join(directory, "lenses"), { recursive: true });
  writeFileSync(join(directory, "lenses/correctness.json"), JSON.stringify({ state: "done", attempts: 1 }));
  writeFileSync(join(directory, "panel.json"), JSON.stringify({ lenses: [{ name: "correctness", title: "Correctness", family: "gpt", model: "gpt-6.1-sol" }], changedFiles: [], cwd: pr.repository, readable: [] }));
  const reservation = join(directory, "round.json");
  writeFileSync(reservation, JSON.stringify({ ...JSON.parse(readFileSync(reservation, "utf8")), capturedBy: "hedge" }));
}

export const ledgerDecisions = (pr: Checkout) => {
  const path = join(pr.home, ".local/state/hedge/decisions.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).decision).filter(Boolean) : [];
};

type Hub = "up" | "down" | "drops appends" | "loses the acknowledgement of appends" | "stalls on appends" | "stalls after it lands an append";
const refused = { code: 255, stdout: "", stderr: "ssh: connect to host hedge-hub port 22: Connection refused\n" };

export function hubAt(pr: Checkout, hub: Hub | boolean = "up") {
  const remote = join(pr.home, "hub-home");
  const hosts: string[] = [];
  const state: { hub: Hub; afterAppend?: () => void } = { hub: hub === true ? "up" : hub === false ? "down" : hub };
  let stalled = () => {};
  const appendStalled = new Promise<void>((resolve) => { stalled = resolve; });
  const stalls: ((result: SshResult) => void)[] = [];
  const stall = () => { stalled(); return new Promise<SshResult>((resolve) => stalls.push(resolve)); };
  const releaseAppends = () => stalls.splice(0).forEach((resolve) => resolve(refused));
  pr.env.HEDGE_SETTINGS = JSON.stringify({ ...settings, "hub.alias": "hedge-hub" });
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

export const graded = (tier: string, grade = "low") => `## Merge risk\n\n<!-- merge-risk -->\n> [!NOTE]\n> 🔵 **Merge risk: ${grade}** · two-way door\n> - **Tier:** ${tier}\n<!-- /merge-risk -->\n`;

export async function finishRound(pr: Checkout, round: string) {
  writeFileSync(join(pr.repository, "findings.md"), `- major | Findings of ${round}.\n`);
  await pr.hedge("review-finish", "--round", round, "--reviewer", "gpt-6.1-sol", "findings.md");
}

export function recordingModel(pr: Checkout, provider: "claude" | "codex", answer: string) {
  const calls = join(pr.home, `${provider}-calls`);
  const reply = provider === "claude" ? `echo '${answer}'` : `for arg in "$@"; do [ "$previous" = "-o" ] && echo '${answer}' > "$arg"; previous="$arg"; done`;
  writeFileSync(join(pr.env.PATH!.split(":")[0]!, provider), `#!/bin/sh\necho "$*" >> "${calls}"\ncat > "${calls}-prompt"\n${reply}\n`, { mode: 0o755 });
  return { calls: () => readFileSync(calls, "utf8").trim().split("\n"), prompt: () => readFileSync(`${calls}-prompt`, "utf8") };
}

const reconnectAfter429 = "ERROR: Reconnecting... 1/5 (stream disconnected before completion: 429 Too Many Requests)";

export const stalledOnQuota = (first = reconnectAfter429, second = first === reconnectAfter429 ? "ERROR: Reconnecting... 2/5" : first) =>
  `cat >/dev/null; printf 'codex\\nreading the diff\\n%s\\n%s\\n' '${first}' '${second}' >&2; exec tail -f /dev/null`;

export const blanks = (stream: 1 | 2) => `head -c 200000 /dev/zero | tr '\\0' ' ' >&${stream}`;
