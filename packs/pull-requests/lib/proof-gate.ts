import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { modelFor, type ModelRow } from "../../base/lib/models.ts";
import { numberSetting } from "../../base/lib/settings.ts";
import { covers, hubLedger, refText, riskCalloutOf, tierOf, type Env, type Ledger, type PrRef, type Ssh } from "./decision-ledger.ts";
import { ciOf, readPullRequest, type PullRequest, type Run } from "./pr-ci.ts";
import { askGap, authorOf, judgeDirectory, judgeGap, judgeGapProof, listStanding, parseVerdict, prDirectory, proofGate, pullRequestDirectory, readDecisions, readJson, receiptOf, reviewRecords, withBrokenConditions, writeJson, type Arbiter, type Decisions, type JudgeSummary, type ProofIdentity, type ProofSummary, type PushedHead } from "./proof.ts";
import { displayEntry } from "./proof-display.ts";
import { baseRefs, cleanBaseMerge, diffOf, mergeBase, pullRequestDetails, smallPr, topLevel } from "./proof-checkout.ts";
import { quietCommitIn } from "./proof-delta.ts";
import { judge, readCriticalPaths, type JudgeInput } from "./proof-judge.ts";
import { askModel, familyOf, modelLabel, readRiskRubric, readRubric, reviewerRow, skillReferences } from "./proof-models.ts";

export type GateContext = { home: string; cwd: string; env: Env; run: Run; now?: () => Date; ssh?: Ssh };
export type FinalGate = { code: number; lines: string[]; verdict: string; summary: ProofSummary };

type Checked = Awaited<ReturnType<typeof proofGate>>;
type Judged = { code: number; lines: string[]; covered: string; judge: JudgeSummary };
type GateKey = { head: string; base: string; baseSha: string; tier: string; callout: string; landed: boolean; fingerprint: string };
type Condition = Checked["conditions"][number];
type SavedGate = { key: GateKey; gate: FinalGate; conditions: Condition[] };

export const reviewLimit = (env: Env) => numberSetting("pull-requests.reviewTimeoutMinutes", env) * 60_000;

const arbiterLimit = 180_000;

export const arbiterOf = ({ env, cwd }: Pick<GateContext, "env" | "cwd">): Arbiter => async (prompt) => {
  const answer = await askModel("arbiter", modelFor("lookup", env), { prompt, cwd }, env, arbiterLimit);
  return answer.ok ? parseVerdict(answer.text, answer.model) : { verdict: "unavailable", reason: answer.cause, model: answer.model };
};

const savedPath = (home: string, ref: PrRef, commit: string) => join(pullRequestDirectory(home, { ...ref, commit }), "gate-outcome", `${commit}.json`);
const unhashed = new Set(["gate-outcome", "judge", "carried", "receipt.json", displayEntry]);

async function proofFiles(home: string, ref: PrRef) {
  const root = prDirectory(home, ref);
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .filter((path) => !unhashed.has(path.split(sep)[0]!)).sort();
  const hash = createHash("sha256");
  for (const path of files) hash.update(`${path}\0`).update(await readFile(join(root, path))).update("\0");
  return hash.digest("hex");
}

async function fingerprintOf(home: string, ref: PrRef, files: string, decisions: Decisions) {
  const covering = Array.isArray(decisions) ? decisions.filter((decision) => covers(decision, ref)) : "unreachable";
  return createHash("sha256").update(JSON.stringify({ files, covering, standing: await listStanding(home) })).digest("hex");
}

const keyOf = (pull: PullRequest, landed: boolean, fingerprint: string): GateKey =>
  ({ head: pull.head, base: pull.base, baseSha: pull.baseSha, tier: tierOf(pull.body), callout: createHash("sha256").update(riskCalloutOf(pull.body) ?? "").digest("hex"), landed, fingerprint });

export async function finalGate(head: ProofIdentity, context: GateContext, { landed = false }: { landed?: boolean } = {}): Promise<FinalGate> {
  const { home, env, run, now, ssh } = context;
  let pull: PullRequest | undefined;
  const pushedHead = pushedHeadOf(head, run, (read) => { pull ??= read; });
  const files = await proofFiles(home, head);
  const checked = await proofGate(home, head, {
    landed, cleanBaseMerge: cleanBaseMerge(head, run), quietCommit: quietCommitIn(run, () => baseRefs(head, run)), small: (body) => smallPr(head, run, body), ci: () => ciOf(home, head, run, now?.() ?? new Date()),
    pushedHead, ledger: hubLedger(home, env, ssh), now: now?.(),
  });
  const judged: Judged = checked.code === 0 ? await judgeHead(head, checked, context) : { code: checked.code, lines: [], covered: "", judge: { state: "skipped", lines: [] } };
  const gate = {
    code: judged.code,
    lines: [...checked.lines, ...judged.lines],
    verdict: judged.code === 0 ? `gate: pass (${checked.summary}; judge: ${judged.covered})` : `gate: fail (exit ${judged.code})`,
    summary: { ...checked.proofSummary, code: judged.code, judge: judged.judge },
  };
  if (pull) await writeJson(savedPath(home, head, head.commit), { key: keyOf(pull, landed, await fingerprintOf(home, head, files, checked.decisions)), gate, conditions: checked.conditions } satisfies SavedGate);
  return gate;
}

const pushedHeadOf = (head: ProofIdentity, run: Run, seen: (pull: PullRequest) => void = () => {}) => (): PushedHead => {
  try {
    const read = readPullRequest(head, run);
    seen(read);
    return { commit: read.head, body: read.body };
  } catch (error) { return { error: (error as Error).message }; }
};

export async function currentSummary(ref: PrRef, pull: PullRequest, ledger: Ledger, context: GateContext): Promise<ProofSummary | undefined> {
  const saved = await savedGate(context.home, ref, pull, ledger);
  if (!saved) return undefined;
  const { home, run, now } = context;
  const head = { ...ref, commit: pull.head };
  let readAsSaved = true;
  const live = await proofGate(home, head, {
    landed: pull.state === "merged", cleanBaseMerge: cleanBaseMerge(head, run), quietCommit: quietCommitIn(run, () => baseRefs(head, run)), small: (body) => smallPr(head, run, body),
    ci: () => ciOf(home, head, run, now?.() ?? new Date()),
    pushedHead: pushedHeadOf(head, run, (read) => { readAsSaved &&= JSON.stringify(keyOf(read, saved.key.landed, saved.key.fingerprint)) === JSON.stringify(saved.key); }),
    ledger, now: now?.(),
  });
  const judged = readAsSaved && JSON.stringify(live.conditions) === JSON.stringify(saved.conditions) && live.proofSummary.ci.line === saved.gate.summary.ci.line && JSON.stringify(live.proofSummary.ci.checks) === JSON.stringify(saved.gate.summary.ci.checks);
  const receipt = await receiptOf(home, ref);
  return { ...saved.gate.summary, ...receipt ? { receipt } : {}, ...live.proofSummary, code: live.code !== 0 ? live.code : judged ? saved.gate.code : 1 };
}

async function savedGate(home: string, ref: PrRef, pull: PullRequest, ledger: Ledger): Promise<SavedGate | undefined> {
  const saved = await readJson<SavedGate | undefined>(savedPath(home, ref, pull.head), undefined);
  if (!saved) return undefined;
  const key = keyOf(pull, pull.state === "merged", await fingerprintOf(home, ref, await proofFiles(home, ref), await readDecisions(ledger)));
  return JSON.stringify(saved.key) === JSON.stringify(key) ? saved : undefined;
}

async function judgeHead(head: ProofIdentity, checked: Checked, context: GateContext): Promise<Judged> {
  const { home, env, run, now } = context;
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
  const outcome = await judgeDiff(head, known, row, context);
  const verdict = (lines: string[], gap?: JudgeSummary["gap"]): JudgeSummary => ({ state: outcome.state, model: outcome.model, ...gap ? { gap } : {}, lines });
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

async function judgeDiff(head: ProofIdentity, known: Omit<JudgeInput, "cwd" | "from" | "diff">, row: ModelRow, context: GateContext) {
  const { home, cwd, env, run, now } = context;
  const from = mergeBase(head, run);
  return judge({ ...known, cwd: topLevel(run) ?? cwd, from, diff: diffOf(from, known.commit, run) }, {
    ask: (request) => askModel("judge", row, request, env, reviewLimit(env)), model: modelLabel("judge", row, env), arbiter: arbiterOf(context),
    directory: judgeDirectory(home, head), commit: known.commit, now: now?.() ?? new Date(),
  });
}

const voidBroken = (ids: string[]) => `End ${ids.map((id) => `decision ${id}`).join(" and ")} with fleet decision void <id> --reason <why its condition no longer holds>, then decide or ask again`;
