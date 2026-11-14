import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { DecisionState } from "./decision-ledger.ts";
import type { Plan } from "./proof-panel.ts";
import type { Display } from "./proof-display.ts";
import type { ReviewDisplay } from "./proof-review-display.ts";
import type { GapProof, KindProof, ProofSummary } from "./proof.ts";

export const receiptOpen = "<!-- fleet-proof-receipt";
export const receiptClose = "<!-- /fleet-proof-receipt -->";
const blockText = String.raw`<!-- fleet-proof-receipt\b[^>]*-->(?:(?!<!-- fleet-proof-receipt)[\s\S])*?<!-- \/fleet-proof-receipt -->`;
const blockAndBreak = new RegExp(String.raw`${blockText}(?:\r?\n){0,2}`, "g");
const marker = /<!-- fleet-proof-receipt head=([0-9a-f]{40}) hash=([0-9a-f]+) -->/;

export const withoutReceipt = (body: string) => body.replace(blockAndBreak, "");

export function receiptMarker(body: string) {
  const match = marker.exec(body);
  return match ? { head: match[1]!, hash: match[2]! } : undefined;
}

export class GuardRefusal extends Error {}

const kept = [/#\d+\b/g, /\b\d{4}-\d{2}-\d{2}\b/g, /\bv?\d{1,3}(?:\.\d{1,3}){1,3}\b/g, /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g];
const email = /[^\s@<>()]+@[^\s@<>()]+\.[\p{L}\p{M}]{2,}/u;
const numbers = [/\p{Nd}\s*(?:%|‰|‱|per\s?cent\b)/iu, /\p{Nd}{1,3}(?:,\p{Nd}{3})+(?!\p{Nd})/u, /\p{Nd}{4,}/u];
const entity = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;
const invisible = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

const rendered = (text: string) => text.normalize("NFKC").replace(invisible, "").replace(/<\/?[a-z][^>]*>/gi, "")
  .replace(/\\([!-/:-@[-`{-~])/g, "$1").replace(/[*_~`]/g, "")
  .replace(/(\p{Nd})[\p{Zs}'’](?=\p{Nd}{3}(?!\p{Nd}))/gu, "$1,").replace(/\p{Zs}/gu, " ");

export function guardField(field: string, text: string) {
  if (text.includes("<!--") || text.includes("-->")) throw new GuardRefusal(`receipt refused: the ${field} holds an HTML comment marker. Remove it.`);
  if (entity.test(text)) throw new GuardRefusal(`receipt refused: the ${field} holds an HTML entity. Write the character itself.`);
  const seen = rendered(text);
  const rest = kept.reduce((value, pattern) => value.replace(pattern, " "), seen);
  if (email.test(seen) || numbers.some((pattern) => pattern.test(rest))) {
    throw new GuardRefusal(`receipt refused: the ${field} looks like a production figure or an email address. Move the detail into an evidence note, which only the full receipt shows.`);
  }
  return text;
}

const short = (commit: string) => commit.slice(0, 7);
const at = (commit: string) => `\`${short(commit)}\``;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
const row = (cells: string[]) => `|${cells.map((text) => text ? ` ${cell(text)} ` : " ").join("|")}|`;
export const prodShapeResult = "measured on production; details in the receipt";

export type ReceiptReview = ReviewDisplay & { lenses?: Plan["lenses"] };
export type ReceiptInput = {
  summary: ProofSummary; decisions: DecisionState[]; display: Display; notChecked: string[]; reviews: ReceiptReview[];
  screenshots: { commit: string; names: string[] }[];
};

export function kindSource(kind: KindProof, head: string) {
  if (kind.state === "ran") return { commit: head, cell: at(head) };
  if (kind.state === "reused") return { commit: kind.from, cell: `${at(head)} (reused from ${at(kind.from)})` };
  if (kind.state === "carried") return { commit: kind.from, cell: `${at(head)} (carried from ${at(kind.from)})` };
  return undefined;
}

function kindRow(kind: KindProof, input: ReceiptInput, warnings: string[]) {
  const head = input.summary.commit;
  const from = kindSource(kind, head);
  if (!from) {
    if (kind.state === "gap") return row([kind.kind, "not run", `gap, ${kind.accepted ? "accepted" : "not accepted"}`, ""]);
    if (kind.state === "pending") return row([kind.kind, "not yet", "pending until the PR lands", ""]);
    return row([kind.kind, "no evidence", "missing", ""]);
  }
  const lines = input.display.lines[from.commit]?.[kind.kind];
  if (!lines) warnings.push(`warning: ${kind.kind} has no line of what ran at ${short(from.commit)}. Run fleet proof save --commit ${from.commit} --kind ${kind.kind} --ran '<what ran>' --result '<what it showed>'`);
  const ran = lines ? guardField(`what ran of ${kind.kind}`, lines.ran) : "no line recorded";
  const result = kind.kind === "prod-shape" ? prodShapeResult : lines ? guardField(`result of ${kind.kind}`, lines.result) : "no line recorded";
  return row([kind.kind, ran, result, from.cell]);
}

function reviewRow(reviews: ReceiptReview[]) {
  if (!reviews.length) return row(["Review", "no finished review", "", ""]);
  for (const review of reviews) {
    guardField("review label", review.label);
    for (const { model } of review.lenses ?? []) guardField(`panel model of ${review.label}`, model);
    if (!review.lenses && review.reviewer) guardField(`reviewer of ${review.label}`, review.reviewer);
  }
  const models = [...new Set(reviews.flatMap((review) => review.lenses?.map((lens) => lens.model) ?? (review.reviewer ? [review.reviewer] : [])))];
  const lenses = Math.max(0, ...reviews.map((review) => review.lenses?.length ?? 0));
  const who = lenses ? `${lenses}-lens panel (${models.join(", ")})` : `single reviewer (${models.join(", ") || "unnamed"})`;
  const sum = (key: keyof ReviewDisplay["counts"]) => reviews.reduce((total, review) => total + review.counts[key], 0);
  const [first, last] = [reviews[0]!.commit, reviews.at(-1)!.commit];
  return row(["Review", `${who}, ${reviews.map((review) => review.label).join(", ")}`, `${sum("findings")} findings: ${sum("fixed")} fixed, ${sum("rejected")} rejected, ${sum("unknown")} other`, first === last ? at(last) : `${at(first)} to ${at(last)}`]);
}

const judgeResults: Record<ProofSummary["judge"]["state"], string> = { pass: "✅ passed at", fail: "❌ failed at", unavailable: "unavailable at", skipped: "not yet run at" };
const judgeRow = ({ judge, commit }: ProofSummary) => row(["Proof judge", "an independent model reads the evidence against the diff", `${judgeResults[judge.state]} ${at(commit)}`, ""]);

function acceptedBy(gap: GapProof, decisions: DecisionState[]) {
  const accepted = gap.accepted;
  if (!accepted) return "not accepted";
  if (accepted.by === "standing rule") return "accepted by a standing rule";
  const decision = decisions.find((candidate) => candidate.id === accepted.id);
  return `accepted by ${accepted.mark ? `${accepted.mark} ` : ""}${accepted.by}${decision ? ` ${decision.at.slice(0, 10)}` : ""}`;
}

export function receiptGaps({ summary }: Pick<ReceiptInput, "summary">): [string, GapProof][] {
  return [
    ...summary.kinds.flatMap((kind): [string, GapProof][] => kind.state === "gap" ? [[kind.kind, kind.gap]] : []),
    ...summary.review.panelGap ? [["panel", summary.review.panelGap] as [string, GapProof]] : [],
    ...summary.ci.gap ? [["ci", summary.ci.gap] as [string, GapProof]] : [],
    ...summary.judge.gap ? [["judge", summary.judge.gap] as [string, GapProof]] : [],
  ];
}

const gapLines = (input: ReceiptInput) => receiptGaps(input).map(([kind, gap]) => `${kind}: ${gap.reason ? guardField(`gap reason of ${kind}`, gap.reason) : "no reason recorded"}, ${acceptedBy(gap, input.decisions)}`);

export function renderSection(input: ReceiptInput) {
  const warnings: string[] = [];
  const rows = input.summary.kinds.map((kind) => kindRow(kind, input, warnings));
  const notChecked = input.notChecked.map((item, index) => guardField(`not-checked item ${index + 1}`, item));
  const gaps = gapLines(input);
  const captioned = new Set(input.display.screenshots.map((shot) => `${shot.commit}/${shot.name}`));
  for (const { commit, names } of input.screenshots) for (const name of names) {
    if (!captioned.has(`${commit}/${name}`)) warnings.push(`warning: screenshot ${name} at ${short(commit)} has no caption. Run fleet proof save --commit ${commit} --kind ui-walk --caption '<what it shows>' <the screenshot>`);
  }
  for (const shot of input.display.screenshots.filter((candidate) => !candidate.url)) {
    warnings.push(`warning: screenshot ${shot.name} at ${short(shot.commit)} has no published URL. Run fleet proof publish --commit ${shot.commit} --asset-repo <owner/fork> <the screenshot>`);
  }
  const section = [
    "| Proof | What ran | Result | Commit |", "| --- | --- | --- | --- |", ...rows, reviewRow(input.reviews), judgeRow(input.summary), "",
    `**Not checked:** ${notChecked.join("; ") || "none recorded"}`,
    ...gaps.length ? [`**Gaps:** ${gaps.join("; ")}`] : [],
  ].join("\n");
  return { section, warnings };
}

export const receiptHash = (section: string, page: string) => createHash("sha256").update(`${section}\n${page}`).digest("hex").slice(0, 16);

const linkLine = "Full receipt: ";
export const withLink = (section: string, url: string) => `${section}\n${linkLine}${url}`;

export function receiptLink(body: string) {
  const start = body.indexOf(receiptOpen);
  const end = body.indexOf(receiptClose);
  if (start < 0 || end < start) return undefined;
  const url = /^Full receipt: (https:\/\/\S+)\s*$/m.exec(body.slice(start, end))?.[1];
  const id = url ? new URL(url).pathname.split("/").filter(Boolean).at(-1) : undefined;
  return url && id ? { url, id } : undefined;
}

export async function screenshotFiles(summary: ProofSummary) {
  return Promise.all(summary.kinds.flatMap((kind) => {
    const from = kind.kind === "ui-walk" ? kindSource(kind, summary.commit) : undefined;
    return from && "directory" in kind ? [readdir(kind.directory).catch(() => [] as string[]).then((names) => ({ commit: from.commit, names }))] : [];
  }));
}

const count = (text: string, part: string) => text.split(part).length - 1;

export function checkMarkers(body: string) {
  const [opens, closes] = [count(body, receiptOpen), count(body, receiptClose)];
  if (opens > 1 || closes > 1 || opens !== closes || body.indexOf(receiptClose) < body.indexOf(receiptOpen)) {
    throw new Error(`The PR body holds broken receipt markers (${opens} opening, ${closes} closing). Fix them by hand to one ${receiptOpen} ... --> and one ${receiptClose}, then run the receipt again`);
  }
}

export type Receipt = { head: string; hash: string; section: string };
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const blockOf = ({ head, hash, section }: Receipt, heading: string | undefined) => `${receiptOpen} head=${head} hash=${hash} -->\n${heading ? `## ${heading}\n\n` : ""}${section}\n${receiptClose}`;

export function placeReceipt(body: string, receipt: Receipt, heading: string) {
  const name = escaped(heading);
  const start = body.indexOf(receiptOpen);
  if (start >= 0) {
    const end = body.indexOf(receiptClose) + receiptClose.length;
    const inside = new RegExp(String.raw`^[^\n]*-->\r?\n#{1,6}[ \t]+${name}`).test(body.slice(start, end));
    return body.slice(0, start) + blockOf(receipt, inside ? heading : undefined) + body.slice(end);
  }
  const found = new RegExp(String.raw`^#{1,6}[ \t]+${name}[ \t]*\r?$`, "m").exec(body);
  const after = found ? found.index + found[0].length : 0;
  const next = found ? /^#{1,2}[ \t]+\S/m.exec(body.slice(after)) : null;
  if (next) return `${body.slice(0, after + next.index)}${blockOf(receipt, undefined)}\n\n${body.slice(after + next.index)}`;
  return `${body}\n${blockOf(receipt, found ? undefined : heading)}\n`;
}
