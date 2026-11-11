import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ledgerRoot } from "./proof.ts";
import { appendLine, hashOf, missSources, readLines, type Miss, type MissSource } from "./proof-misses.ts";
import type { ModelAnswer } from "./proof-models.ts";
import type { Slot } from "./proof-panel.ts";
import { reviewedDiff, reviewPrompt } from "./proof-review.ts";
import { reviewRules } from "./review-rules.ts";

type Outcome = "caught" | "missed" | "skipped" | "failed";
type CaseResult = { id: string; repo: string; pr: number; source: MissSource; outcome: Outcome; reason: string; reviewer?: string; findings?: string };
export type EvalRun = { at: string; reviewer: string; judge: string; promptHash: string; inputsHash: string; cases: CaseResult[] };

export const evalsPath = (home: string) => join(ledgerRoot(home), "evals.jsonl");

export const promptTemplateHash = () => hashOf([reviewPrompt({ scope: "", from: "", commit: "", diff: "", diffFile: "", crossFamily: false, title: "", body: "", rubric: "", references: [], reviewRules: "" })]);

type Run = (command: string[]) => { code: number; stdout: string; stderr: string };
export type EvalIO = {
  checkoutOf: (repo: string) => string | undefined;
  runIn: (cwd: string) => Run;
  crossFamily: (miss: Miss) => Promise<boolean>;
  review: (miss: Miss, prompt: string, cwd: string, readable: string, slot: Slot) => Promise<ModelAnswer>;
  judge: (prompt: string, slot: Slot) => Promise<ModelAnswer>;
  slot: <T>(work: (slot: Slot) => Promise<T>) => Promise<T>;
  rubric: string; references: string[];
};

export const scoreCases = (cases: Miss[], io: EvalIO) => Promise.all(cases.map((miss) => scoreCase(miss, io)));

async function scoreCase(miss: Miss, io: EvalIO): Promise<CaseResult> {
  const result = (outcome: Outcome, reason: string, findings?: { model: string; text?: string }): CaseResult =>
    ({ id: miss.id, repo: miss.repo, pr: miss.pr, source: miss.source, outcome, reason, reviewer: findings?.model, findings: findings?.text });
  const checkout = io.checkoutOf(miss.repo);
  if (!checkout) return result("skipped", `no checkout of ${miss.repo}; run in one or pass --checkout ${miss.repo}=<path>`);
  const run = io.runIn(checkout);
  const absent = [miss.base, miss.head].filter((commit) => run(["git", "cat-file", "-e", `${commit}^{commit}`]).code !== 0);
  if (absent.length) return result("skipped", `${absent.map(short).join(" and ")} missing in ${checkout}; fetch them there`);
  try {
    return await io.slot(async (slot) => {
      const diff = run(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-relative", miss.base, miss.head]);
      if (diff.code !== 0) return result("failed", `cannot diff ${short(miss.base)}..${short(miss.head)} (${firstLine(diff.stderr)})`);
      const changedFiles = run(["git", "diff", "--name-only", "--no-relative", miss.base, miss.head]).stdout.split("\n").filter(Boolean);
      const crossFamily = await io.crossFamily(miss);
      const findings = await inWorktree(checkout, miss.head, run, async (tree) => {
        const diffFile = join(dirname(tree), "diff.patch");
        const masked = reviewedDiff(diff.stdout);
        await writeFile(diffFile, masked, { mode: 0o600 });
        const prompt = reviewPrompt({
          scope: miss.scope, from: miss.base, commit: miss.head, diff: masked, diffFile, crossFamily, title: miss.title, body: miss.body,
          rubric: io.rubric, references: io.references, reviewRules: reviewRules(changedFiles, miss.base, run),
        });
        return io.review(miss, prompt, tree, dirname(tree), slot);
      });
      if (!findings.ok) return result("failed", `the reviewer ${findings.model} gave no findings (${findings.cause})`, findings);
      const judged = await io.judge(judgePrompt(miss, findings.text), slot);
      const verdict = judged.ok ? parseJudgement(judged.text) : undefined;
      if (!verdict) return result("failed", `the judge ${judged.model} gave no verdict (${judged.ok ? `unparseable: ${firstLine(judged.text).slice(0, 200)}` : judged.cause})`, findings);
      return result(verdict.outcome, verdict.reason, findings);
    });
  } catch (error) {
    return result("failed", (error as Error).message);
  }
}

async function inWorktree<T>(checkout: string, commit: string, run: Run, work: (tree: string) => Promise<T>) {
  const tree = join(await mkdtemp(join(tmpdir(), "fleet-proof-eval-")), "checkout");
  const added = run(["git", "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--quiet", tree, commit]);
  try {
    if (added.code !== 0) throw new Error(`cannot check out ${short(commit)} in ${checkout} (${firstLine(added.stderr)})`);
    return await work(tree);
  } finally {
    if (added.code === 0) run(["git", "worktree", "remove", "--force", tree]);
    await rm(join(tree, ".."), { recursive: true, force: true });
  }
}

const judgeInstructions = `You check one code review for one known problem. The review ran first. Later, a <source> found the known problem in the same change. Decide whether one of the review's findings names that problem: the same defect, by its place or by its cause. A finding about another problem, or a general remark that does not point at this one, does not name it. "No findings." names nothing.

Your first line must be exactly NAMED or NOT NAMED, then a colon and one sentence that quotes the finding that names the problem, or says why none does. Write nothing else.`;

const sourceNames: Record<MissSource, string> = { human: "human reviewer", bot: "review bot", ci: "CI run", rollback: "rollback", revert: "revert" };

export function judgePrompt(miss: Miss, findings: string) {
  const place = miss.file ? `\nPlace: ${miss.file}${miss.line ? `:${miss.line}` : ""}` : "";
  return `${judgeInstructions.replace("<source>", sourceNames[miss.source])}

<known-problem>
${miss.finding}${place}
</known-problem>

<review-findings>
${findings.trim()}
</review-findings>
`;
}

function parseJudgement(text: string) {
  const line = (text.split("\n").find((part) => part.trim()) ?? "").replace(/^[\s*`]+|[\s*`]+$/g, "");
  const match = /^(NAMED|NOT NAMED)\b:?\s*(.*)$/.exec(line);
  return match ? { outcome: match[1] === "NAMED" ? "caught" as const : "missed" as const, reason: match[2]!.trim() } : undefined;
}

export const readRuns = (home: string) => readLines<EvalRun>(evalsPath(home));

export const saveRun = (home: string, run: EvalRun) => appendLine(evalsPath(home), run);

const scored = (cases: CaseResult[]) => cases.filter((result) => result.outcome === "caught" || result.outcome === "missed");
const caughtCount = (cases: CaseResult[]) => cases.filter((result) => result.outcome === "caught").length;
const recall = (cases: CaseResult[]) => `${caughtCount(cases)}/${cases.length} (${Math.round((100 * caughtCount(cases)) / cases.length)}%)`;

export function reportLines(run: EvalRun, previous: EvalRun | undefined) {
  const cases = run.cases.map((result) => `${result.id} ${result.repo}#${result.pr} (${result.source}): ${result.outcome}: ${result.reason}`);
  const counted = scored(run.cases);
  const bySource = missSources.map((source) => counted.filter((result) => result.source === source)).filter((group) => group.length).map((group) => `recall ${group[0]!.source}: ${recall(group)}`);
  const overall = counted.length ? `recall overall: ${recall(counted)}` : "recall overall: no case was scored";
  return [...cases, ...bySource, overall, ...comparisonLines(run, previous)];
}

function comparisonLines(run: EvalRun, previous: EvalRun | undefined) {
  if (!previous) return ["previous run: none"];
  const before = new Map(scored(previous.cases).map((result) => [result.id, result]));
  const now = scored(run.cases).filter((result) => before.has(result.id));
  const header = `previous run ${previous.at} by ${previous.reviewer}`;
  if (!now.length) return [`${header}: it scored none of these cases`];
  const changes = [
    ...(previous.promptHash !== run.promptHash ? ["the review prompt template changed"] : []),
    ...(previous.inputsHash !== run.inputsHash ? ["PANEL.md, the coding standards, or the skill references changed"] : []),
  ];
  const flipped = now.filter((result) => before.get(result.id)!.outcome !== result.outcome).map((result) => `${result.id}: ${before.get(result.id)!.outcome} -> ${result.outcome}`);
  return [`${header}: ${recall(now.map((result) => before.get(result.id)!))} on the ${now.length} shared case(s), now ${recall(now)}`, ...changes, ...flipped];
}

const short = (commit: string) => commit.slice(0, 7);
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";
