import { join } from "node:path";
import { modelFor, type ModelRow } from "../../base/lib/models.ts";
import { numberSetting } from "../../base/lib/settings.ts";
import { hubLedger, refText, type Env, type Ssh } from "./decision-ledger.ts";
import { ciOf, pushedHeadOf, type Run } from "./pr-ci.ts";
import { askGap, authorOf, judgeDirectory, judgeGap, judgeGapProof, parseVerdict, proofGate, pullRequestDirectory, readJson, reviewRecords, withBrokenConditions, writeJson, type Arbiter, type JudgeSummary, type ProofIdentity, type ProofSummary } from "./proof.ts";
import { cleanBaseMerge, diffOf, mergeBase, pullRequestDetails, topLevel } from "./proof-checkout.ts";
import { quietCommitIn } from "./proof-delta.ts";
import { judge, judgeFingerprint, readCriticalPaths, type JudgeInput, type JudgeOutcome } from "./proof-judge.ts";
import { askModel, familyOf, modelLabel, readRiskRubric, readRubric, reviewerRow, skillReferences } from "./proof-models.ts";

export type GateContext = { home: string; cwd: string; env: Env; run: Run; now?: () => Date; ssh?: Ssh };
export type JudgeMode = "run" | "cached";
export type FinalGate = { code: number; lines: string[]; verdict: string; summary: ProofSummary };

type Checked = Awaited<ReturnType<typeof proofGate>>;
type Judged = { code: number; lines: string[]; covered: string; judge: JudgeSummary };

export const reviewLimit = (env: Env) => numberSetting("pull-requests.reviewTimeoutMinutes", env) * 60_000;

const arbiterLimit = 180_000;

export const arbiterOf = ({ env, cwd }: Pick<GateContext, "env" | "cwd">): Arbiter => async (prompt) => {
  const answer = await askModel("arbiter", modelFor("lookup", env), { prompt, cwd }, env, arbiterLimit);
  return answer.ok ? parseVerdict(answer.text, answer.model) : { verdict: "unavailable", reason: answer.cause, model: answer.model };
};

export async function finalGate(head: ProofIdentity, context: GateContext, { landed = false, judge: mode }: { landed?: boolean; judge: JudgeMode }): Promise<FinalGate> {
  const { home, env, run, now, ssh } = context;
  const checked = await proofGate(home, head, {
    landed, cleanBaseMerge: cleanBaseMerge(head, run), quietCommit: quietCommitIn(run), ci: () => ciOf(home, head, run, now?.() ?? new Date()),
    pushedHead: () => pushedHeadOf(head, run), ledger: hubLedger(home, env, ssh), now: now?.(),
  });
  const judged: Judged = checked.code === 0 ? await judgeHead(head, checked, context, mode) : { code: checked.code, lines: [], covered: "", judge: { state: "skipped", lines: [] } };
  return {
    code: judged.code,
    lines: [...checked.lines, ...judged.lines],
    verdict: judged.code === 0 ? `gate: pass (${checked.summary}; judge: ${judged.covered})` : `gate: fail (exit ${judged.code})`,
    summary: { ...checked.proofSummary, code: judged.code, judge: judged.judge },
  };
}

type SavedOutcome = { commit: string; fingerprint: string; outcome: JudgeOutcome };

async function judgeHead(head: ProofIdentity, checked: Checked, context: GateContext, mode: JudgeMode): Promise<Judged> {
  const { home, cwd, env, run, now } = context;
  const author = await authorOf(home, head);
  const row = reviewerRow(author, env);
  const riskRubric = await readRiskRubric(home);
  const today = now?.() ?? new Date();
  const weighedGap = await judgeGap(home, head, today, checked.decisions, checked.tier);
  const known = {
    risk: riskRubric === undefined ? undefined : { rubric: riskRubric, body: pullRequestDetails(head, run).body },
    commit: head.commit, crossFamily: familyOf(row) !== author, ci: checked.ci, owed: checked.owed!, ledger: checked.lines,
    evidence: checked.evidence, reviews: await reviewRecords(home, head), rubric: await readRubric(home), references: skillReferences(home),
    conditions: [...checked.conditions, ...weighedGap?.condition ? [weighedGap.condition] : []], criticalPaths: await readCriticalPaths(home, head.repository, env),
  };
  const model = modelLabel("judge", row, env);
  const fingerprint = await judgeFingerprint({ ...known, cwd, from: "", diff: "" }, model);
  const saved = join(pullRequestDirectory(home, head), "judge-outcome.json");
  const outcome = mode === "cached"
    ? await readJson<SavedOutcome | undefined>(saved, undefined).then((record) => record?.commit === head.commit && record.fingerprint === fingerprint ? record.outcome : notRun(model))
    : await judgeAndSave(head, known, row, fingerprint, saved, context);
  const verdict = (lines: string[], gap?: JudgeSummary["gap"]): JudgeSummary => ({ state: outcome.state, model: outcome.model, ...gap ? { gap } : {}, lines });
  if (outcome.state === "not run") return { code: 1, lines: outcome.lines, covered: "", judge: verdict(outcome.lines) };
  if (riskRubric === undefined) outcome.lines.push("judge risk: not asked; ~/.agents/skills/merge-risk/SKILL.md is not installed");
  if (outcome.state === "pass") return { code: 0, lines: outcome.lines, covered: `pass by ${outcome.model}`, judge: verdict(outcome.lines) };
  const gap = weighedGap && withBrokenConditions(weighedGap, outcome.broken);
  if (gap?.acceptance) {
    const lines = [...outcome.lines, `judge gap: ${gap.acceptance.line}: ${gap.reason}`];
    return { code: 0, lines, covered: `${outcome.state} accepted by ${gap.acceptance.by}`, judge: verdict(lines, judgeGapProof(head.commit, gap)) };
  }
  if (gap) {
    const lines = [...outcome.lines, `judge gap: ${gap.line}: ${gap.reason}. ${gap.broken ? voidBroken(gap.broken) : askGap(head, "judge", gap.reason)}`];
    return { code: 3, lines, covered: "", judge: verdict(lines, judgeGapProof(head.commit, gap)) };
  }
  const hint = checked.tier === "ungraded"
    ? "judge gap: when the judge is wrong, record fleet proof gap --kind judge --reason <why> and ask the user; an agent never decides on an ungraded PR"
    : `judge gap: when the judge is wrong, record fleet proof gap --kind judge --reason <why> and decide it with fleet decision record --mark 🤖 --class proof-gap --kind judge --pr ${refText(head)} --question <q> --answer <a> --rejected <option> --reason <why>, or ask the user`;
  const lines = [...outcome.lines, hint];
  return { code: 1, lines, covered: "", judge: verdict(lines) };
}

async function judgeAndSave(head: ProofIdentity, known: Omit<JudgeInput, "cwd" | "from" | "diff">, row: ModelRow, fingerprint: string, saved: string, context: GateContext) {
  const { home, cwd, env, run, now } = context;
  const from = mergeBase(head, run);
  const outcome = await judge({ ...known, cwd: topLevel(run) ?? cwd, from, diff: diffOf(from, known.commit, run) }, {
    ask: (request) => askModel("judge", row, request, env, reviewLimit(env)), model: modelLabel("judge", row, env), arbiter: arbiterOf(context),
    directory: judgeDirectory(home, head), commit: known.commit, now: now?.() ?? new Date(),
  });
  await writeJson(saved, { commit: known.commit, fingerprint, outcome } satisfies SavedOutcome);
  return outcome;
}

const notRun = (model: string): JudgeOutcome => ({ state: "not run", lines: ["judge: not run at HEAD with these proofs; run fleet proof gate"], model, broken: [] });

const voidBroken = (ids: string[]) => `End ${ids.map((id) => `decision ${id}`).join(" and ")} with fleet decision void <id> --reason <why its condition no longer holds>, then decide or ask again`;
