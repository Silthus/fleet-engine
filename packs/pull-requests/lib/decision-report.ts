import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { optionalStringSetting } from "../../base/lib/settings.ts";
import { findThread, withT3Session } from "../../base/lib/t3/index.ts";
import { covers, decisionLine, refText, type DecisionState, type Mark, type PrRef } from "./decision-ledger.ts";
import type { DecisionContext } from "./decision-cli.ts";
import { readPullRequest, runIn } from "./pr-ci.ts";
import { proofSummaryAt } from "./proof-cli.ts";
import type { GapProof, ProofSummary } from "./proof.ts";

export const rolloutLogSetting = "orchestration.rolloutLog";

type LanePr = { ref: PrRef; summary: ProofSummary; state: "open" | "closed" | "merged" };
type RolloutLine = { at?: string; repo?: string; pr?: number; stage?: string; note?: string };

const markOrder: Mark[] = ["👤", "👍", "🤖"];
const short = (commit: string) => commit.slice(0, 7);
const cell = (items: string[], empty: string) => (items.length ? items.join("; ") : empty).replace(/\|/g, "\\|").replace(/\n/g, " ");
const listed = (lines: string[]) => lines.length ? lines : ["None."];
const sameThread = (a: string, b: string) => a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`);

async function lanePr(ref: PrRef, context: DecisionContext): Promise<LanePr> {
  const pull = readPullRequest({ ...ref, commit: "" }, runIn(context.cwd, context.env));
  return { ref, summary: await proofSummaryAt({ ...ref, commit: pull.head }, context), state: pull.state };
}

const t3PendingCard = (home: string) => async (thread: string) => {
  const found = await withT3Session((client) => findThread(client, thread), { home });
  return (found?.pendingRuntimeRequest as { kind?: string } | null | undefined)?.kind === "user_input";
};

const lapseOf = (gap: GapProof) => /^not accepted \((.+)\)$/.exec(gap.text)?.[1];

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
  ];
}

function stillYours(lane: LanePr[], card: string | undefined) {
  const blockers = lane.filter(({ summary }) => summary.tier === "critical").flatMap(({ ref, summary }) =>
    gaps(summary).filter(({ gap }) => !gap.accepted).map(({ kind, gap }) => {
      const lapse = lapseOf(gap);
      return `- **Blocker:** ${refText(ref)} is critical at HEAD and its ${kind} gap is not accepted: ${gap.reason ?? "no reason recorded"}${lapse ? ` (${lapse})` : ""}.`;
    }));
  const merges = lane.filter(({ summary, state }) => state === "open" && summary.code === 0)
    .map(({ ref }) => `- Merge ${refText(ref)}: its proofs pass, and it waits on your merge word.`);
  return [...blockers, ...card ? [`- A question card waits for your answer in thread ${card}.`] : [], ...merges];
}

async function grantMerges(prs: PrRef[], context: DecisionContext) {
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
    .map((line) => `- ${line.repo}#${line.pr} merged ${line.at ? `${new Date(line.at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "at an unknown time"} (${line.note})`);
}

function proofRow({ ref, summary }: LanePr, decisions: DecisionState[]) {
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
  ];
  const voided = [
    ...summary.lapsed.map((id) => `${id} lapsed`),
    ...summary.voided.map((id) => `${id} voided`),
    ...decisions.filter((decision) => decision.reversed && covers(decision, ref)).map((decision) => `${decision.id} reversed`),
  ];
  const receipt = summary.receipt ? `[receipt](${summary.receipt})` : "none yet";
  return `| ${refText(ref)} | ${cell(ran, "none")} | ${cell(deferred, "none")} | ${cell(voided, "none")} | ${receipt} |`;
}

export async function renderReport({ prs, thread }: { prs: PrRef[]; thread?: string }, decisions: DecisionState[], context: DecisionContext): Promise<string> {
  const lane = await Promise.all(prs.map((ref) => lanePr(ref, context)));
  const card = thread && await (context.pendingCard ?? t3PendingCard(context.home))(thread) ? thread : undefined;
  const ours = decisions.filter((decision) => prs.some((ref) => covers(decision, ref)) || (thread !== undefined && sameThread(decision.where.thread, thread)));
  const sorted = ours.map((decision, index) => ({ decision, index }))
    .sort((a, b) => markOrder.indexOf(a.decision.mark) - markOrder.indexOf(b.decision.mark) || a.index - b.index).map(({ decision }) => decision);
  const sideFixes = ours.filter((decision) => decision.class === "scope" && decision.where.link)
    .map((decision) => `- ${decision.question} ${decision.answer}: ${decision.where.link} [${decision.id}]`);
  return [
    `## End-of-run report: ${prs.map(refText).join(", ")}`, "",
    "### Still yours", ...listed(stillYours(lane, card)), "",
    "### Merged under the narrow grant", ...listed(await grantMerges(prs, context)), "",
    "### Decisions", ...listed(sorted.map(decisionLine)), "",
    "### Proofs", "| PR | Ran | Deferred | Voided | Receipt |", "| --- | --- | --- | --- | --- |", ...lane.map((pr) => proofRow(pr, decisions)), "",
    "### Side fixes started", ...listed(sideFixes),
  ].join("\n");
}
