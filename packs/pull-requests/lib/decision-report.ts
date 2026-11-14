import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { optionalStringSetting } from "../../base/lib/settings.ts";
import { findThread, questionCard, withT3Session } from "../../base/lib/t3/index.ts";
import { covers, decisionLine, refText, type DecisionState, type Env, type Ledger, type Mark, type PrRef, type Ssh } from "./decision-ledger.ts";
import { readPullRequest, runIn, type PullRequest } from "./pr-ci.ts";
import { receiptOf, type GapProof, type ProofSummary } from "./proof.ts";
import { currentSummary } from "./proof-gate.ts";

export type ReportContext = { home: string; cwd: string; env: Env; now?: () => Date; ssh?: Ssh; pendingCard?: (thread: string) => Promise<boolean> };

export const rolloutLogSetting = "orchestration.rolloutLog";

type LanePr = { ref: PrRef; summary: ProofSummary; state: PullRequest["state"] };
type UngatedPr = { ref: PrRef; ungated: string; state: PullRequest["state"]; receipt?: string };
type UnknownPr = { ref: PrRef; unknown: string };
type Row = LanePr | UngatedPr | UnknownPr;
const gated = (pr: Row): pr is LanePr => "summary" in pr;
type RolloutLine = { at?: string; repo?: string; pr?: number; stage?: string; note?: string };

const markOrder: Mark[] = ["👤", "👍", "🤖"];
const short = (commit: string) => commit.slice(0, 7);
const cell = (items: string[], empty: string) => (items.length ? items.join("; ") : empty).replace(/\|/g, "\\|").replace(/\n/g, " ");
const listed = (lines: string[]) => lines.length ? lines : ["None."];
const sameThread = (a: string, b: string) => a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`);

async function lanePr(ref: PrRef, ledger: Ledger, context: ReportContext): Promise<Row> {
  const { home, cwd, env, now, ssh } = context;
  try {
    const run = runIn(cwd, env);
    const pull = readPullRequest({ ...ref, commit: "" }, run);
    const summary = await currentSummary(ref, pull, ledger, { home, cwd, env, run, now, ssh });
    if (summary) return { ref, summary, state: pull.state };
    const receipt = await receiptOf(home, ref);
    return { ref, ungated: pull.head, state: pull.state, ...receipt ? { receipt } : {} };
  } catch (error) { return { ref, unknown: (error as Error).message }; }
}

const t3PendingCard = (home: string) => async (thread: string) =>
  questionCard(await withT3Session((client) => findThread(client, thread), { home })) !== undefined;

function acceptedBy(gap: GapProof) {
  const by = gap.accepted;
  if (!by) return "not accepted";
  return by.id ? `accepted by ${by.mark ?? by.by} ${by.id}` : `accepted by ${by.by}`;
}

function gaps(summary: ProofSummary): { kind: string; gap: GapProof }[] {
  return [
    ...summary.kinds.flatMap((kind) => kind.state === "gap" ? [{ kind: kind.kind as string, gap: kind.gap }] : []),
    ...summary.review.panelGap ? [{ kind: "panel", gap: summary.review.panelGap }] : [],
    ...summary.ci.gap ? [{ kind: "ci", gap: summary.ci.gap }] : [],
    ...summary.judge.gap ? [{ kind: "judge", gap: summary.judge.gap }] : [],
  ];
}

function stillYours(rows: Row[], card: string | undefined) {
  const lane = rows.filter(gated);
  const blockers = lane.filter(({ state, summary }) => state !== "closed" && summary.tier === "critical").flatMap(({ ref, summary }) =>
    gaps(summary).filter(({ gap }) => !gap.accepted).map(({ kind, gap }) =>
      `- **Blocker:** ${refText(ref)} is critical at HEAD and its ${kind} gap is not accepted: ${gap.reason ?? "no reason recorded"}${gap.lapsed ? ` (🤖 decision ${gap.lapsed.id} lapsed: ${gap.lapsed.reason})` : ""}.`));
  const unknown = rows.flatMap((pr) => "unknown" in pr ? [`- ${refText(pr.ref)}: its proofs are not known here (${pr.unknown}). Run fleet proof gate.`] : []);
  const ungated = rows.flatMap((pr) => "ungated" in pr && pr.state !== "closed"
    ? [`- ${refText(pr.ref)}: the gate has not run at HEAD ${short(pr.ungated)} with these proofs, so they are not known to pass. Run fleet proof gate${pr.state === "merged" ? " --landed" : ""}.`] : []);
  const blocked = new Set(lane.filter(({ summary }) => summary.tier === "critical" && gaps(summary).some(({ gap }) => !gap.accepted)).map(({ ref }) => refText(ref)));
  const failing = lane.filter(({ ref, state, summary }) => state !== "closed" && summary.code !== 0 && !blocked.has(refText(ref)))
    .map(({ ref, state, summary }) => `- ${refText(ref)}: its proofs are not shown to pass at HEAD ${short(summary.commit)} as read now (gate exit ${summary.code}). Run fleet proof gate${state === "merged" ? " --landed" : ""} in its checkout to see why.`);
  const merges = lane.filter(({ state, summary }) => state === "open" && summary.code === 0)
    .map(({ ref }) => `- Merge ${refText(ref)}: its proofs pass, and it waits on your merge word.`);
  return [...blockers, ...card ? [`- A question card waits for your answer in thread ${card}.`] : [], ...unknown, ...ungated, ...failing, ...merges];
}

const mergedAt = (at: string | undefined) => at && Number.isFinite(Date.parse(at)) ? `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "at an unknown time";

async function grantMerges(prs: PrRef[], context: ReportContext) {
  const setting = optionalStringSetting(rolloutLogSetting, context.env);
  if (!setting) return [`- No rollout log: the setting ${rolloutLogSetting} is empty, so merges under the grant are unknown.`];
  const path = setting.startsWith("~/") ? join(context.home, setting.slice(2)) : setting;
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [`- The rollout log ${path} is missing, so merges under the grant are unknown.`];
    throw error;
  }
  const lines = text.split("\n").flatMap((line): RolloutLine[] => { try { return line.trim() ? [JSON.parse(line) as RolloutLine] : []; } catch { return []; } });
  const inLane = (line: RolloutLine) => prs.some((ref) => line.repo?.toLowerCase() === ref.repository.toLowerCase() && line.pr === ref.pr);
  return lines.filter((line) => line.stage === "merged" && /narrow grant/i.test(line.note ?? "") && inLane(line))
    .map((line) => `- ${line.repo}#${line.pr} merged ${mergedAt(line.at)} (${line.note})`);
}

const receiptCell = (url: string | undefined) => url ? `[receipt](${url})` : "none yet";

function proofRow(pr: Row, decisions: DecisionState[]) {
  const reversed = decisions.filter((decision) => decision.reversed && covers(decision, pr.ref)).map((decision) => `${decision.id} reversed`);
  if ("unknown" in pr) return `| ${refText(pr.ref)} | ${cell([`not known here: ${pr.unknown}`], "")} | none | ${cell(reversed, "none")} | none yet |`;
  if ("ungated" in pr) return `| ${refText(pr.ref)} | none | gate: not run at HEAD ${short(pr.ungated)} with these proofs | ${cell(reversed, "none")} | ${receiptCell(pr.receipt)} |`;
  const { ref, summary } = pr;
  const ran = summary.kinds.flatMap((kind) =>
    kind.state === "ran" ? [`${kind.kind} at ${short(kind.commit)}`]
    : kind.state === "reused" ? [`${kind.kind} reused from ${short(kind.from)}`]
    : kind.state === "carried" ? [`${kind.kind} carried from ${short(kind.from)}`] : []);
  if (summary.owed.state === "none") ran.push(`none owed (${summary.owed.reason ?? "no reason recorded"})`);
  const deferredGap = (kind: string, gap: GapProof) => `${kind}: ${gap.reason ?? "no reason recorded"} (${acceptedBy(gap)})`;
  const deferred = [
    ...summary.owed.state === "unrecorded" ? ["owed proofs: not recorded"] : [],
    ...summary.kinds.flatMap((kind) =>
      kind.state === "missing" ? [`${kind.kind}: missing`]
      : kind.state === "pending" ? [`${kind.kind}: pending until the PR lands`]
      : kind.state === "gap" ? [deferredGap(kind.kind, kind.gap)] : []),
    ...summary.review.panelGap ? [deferredGap("panel", summary.review.panelGap)] : [],
    ...summary.ci.gap ? [deferredGap("ci", summary.ci.gap)] : [],
    ...summary.judge.gap ? [deferredGap("judge", summary.judge.gap)] : summary.judge.state === "pass" ? [] : [summary.judge.state === "skipped" ? "judge: not run at HEAD" : `judge: ${summary.judge.state}`],
  ];
  const voided = [
    ...summary.lapsed.map((id) => `${id} lapsed`),
    ...summary.voided.map((id) => `${id} voided`),
    ...reversed,
  ];
  return `| ${refText(ref)} | ${cell(ran, "none")} | ${cell(deferred, "none")} | ${cell(voided, "none")} | ${receiptCell(summary.receipt)} |`;
}

export async function renderReport({ prs, thread }: { prs: PrRef[]; thread?: string }, ledger: Ledger, decisions: DecisionState[], context: ReportContext): Promise<string> {
  const rows = await Promise.all(prs.map((ref) => lanePr(ref, ledger, context)));
  const card = thread && await (context.pendingCard ?? t3PendingCard(context.home))(thread) ? thread : undefined;
  const ours = decisions.filter((decision) => prs.some((ref) => covers(decision, ref)) || (thread !== undefined && sameThread(decision.where.thread, thread)));
  const sorted = [...ours].sort((a, b) => markOrder.indexOf(a.mark) - markOrder.indexOf(b.mark));
  const sideFixes = ours.filter((decision) => decision.class === "scope" && decision.where.link)
    .map((decision) => `- ${decision.question} ${decision.answer}: ${decision.where.link} [${decision.id}]`);
  return [
    `## End-of-run report: ${prs.map(refText).join(", ")}`, "",
    "### Still yours", ...listed(stillYours(rows, card)), "",
    "### Merged under the narrow grant", ...listed(await grantMerges(prs, context)), "",
    "### Decisions", ...listed(sorted.map(decisionLine)), "",
    "### Proofs", "| PR | Ran | Deferred | Voided | Receipt |", "| --- | --- | --- | --- | --- |", ...rows.map((pr) => proofRow(pr, decisions)), "",
    "### Side fixes started", ...listed(sideFixes),
  ].join("\n");
}
