import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { riskCalloutOf, type DecisionState } from "./decision-ledger.ts";
import type { Display } from "./proof-display.ts";
import type { ReviewDisplay } from "./proof-review-display.ts";
import { summaryGaps, type GapProof, type KindProof, type ProofSummary } from "./proof.ts";

export const receiptOpen = "<!-- fleet-proof-receipt";
export const receiptClose = "<!-- /fleet-proof-receipt -->";
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const blockText = String.raw`${escaped(receiptOpen)}\b[^>]*-->(?:(?!${escaped(receiptOpen)})[\s\S])*?${escaped(receiptClose)}`;
const blockAndBreak = new RegExp(String.raw`${blockText}(?:\r?\n){0,2}`, "g");
const marker = /<!-- fleet-proof-receipt head=([0-9a-f]{40}) hash=([0-9a-f]+) -->/;

export function withoutReceipt(body: string) {
  const stripped = body.replace(blockAndBreak, "");
  return riskCalloutOf(stripped) === riskCalloutOf(body) ? stripped : body;
}

export function receiptMarker(body: string) {
  const match = marker.exec(body);
  return match ? { head: match[1]!, hash: match[2]! } : undefined;
}

export class GuardRefusal extends Error {}

const kept = [/#\d+\b/g, /\b\d{4}-\d{2}-\d{2}\b/g, /\bv?\d{1,3}(?:\.\d{1,3}){1,3}\b/g, /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g];
const email = /[^\s@<>()]+@(?:[^\s@<>()]+\.[\p{L}\p{M}]{2,}|\[[^\]\s]+\])/u;
const percent = /\p{Nd}\s*(?:[%‰‱\u066a\u0609\u060a]|per\s?cent\b|pct\b)/iu;
const figures = [/\p{Nd}{1,3}(?:,\p{Nd}{3})+(?!\p{Nd})/u, /\p{Nd}{4,}/u, /(?![0-9])\p{Nd}/u];
const entity = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i;
const invisible = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" };

const spaced = (text: string) => text.replace(/(\p{Nd})[\p{Zs}'’\u066c\u060c\u2e41](?=\p{Nd}{3}(?!\p{Nd}))/gu, "$1,").replace(/\p{Zs}/gu, " ");
const shown = (text: string) => spaced(Bun.markdown.html(text).replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, "$1").replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => named[name]!));

function views(text: string) {
  const plain = text.normalize("NFKC").replace(invisible, "");
  return { written: spaced(plain), read: [shown(plain), spaced(plain.replace(/`/g, "")), spaced(plain.replace(/[`*_~]/g, ""))] };
}

const holdsFigure = (seen: string) => figures.some((pattern) => pattern.test(kept.reduce((value, exempt) => value.replace(exempt, " "), seen)));

const codeSpan = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
const escapeMarkup = (text: string) => text.replace(/[\\`*_~[\]<>&!]/g, "\\$&");
function literal(text: string) {
  let out = "";
  let last = 0;
  for (const span of text.matchAll(codeSpan)) {
    out += escapeMarkup(text.slice(last, span.index)) + span[0];
    last = span.index + span[0].length;
  }
  return out + escapeMarkup(text.slice(last));
}

export function guardField(field: string, text: string) {
  if (text.includes("<!--") || text.includes("-->")) throw new GuardRefusal(`receipt refused: the ${field} holds an HTML comment marker. Remove it.`);
  if (entity.test(text)) throw new GuardRefusal(`receipt refused: the ${field} holds an HTML entity. Write the character itself.`);
  const { written, read } = views(text);
  if (holdsFigure(written) || read.some((seen) => email.test(seen) || percent.test(seen) || holdsFigure(seen))) {
    throw new GuardRefusal(`receipt refused: the ${field} looks like a production figure or an email address. Move the detail into an evidence note, which only the full receipt shows.`);
  }
  return literal(text);
}

const modelSnapshot = /-20\d{6}$/;
function guardModel(field: string, model: string) {
  guardField(field, model.replace(modelSnapshot, ""));
  return literal(model);
}

const short = (commit: string) => commit.slice(0, 7);
const at = (commit: string) => `\`${short(commit)}\``;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
const row = (cells: string[]) => `|${cells.map((text) => text ? ` ${cell(text)} ` : " ").join("|")}|`;
export const prodShapeResult = "measured on production; details in the receipt";

export type ReceiptReview = ReviewDisplay & { lenses?: string[] };
export type ReceiptInput = {
  summary: ProofSummary; decisions: DecisionState[]; display: Display; notChecked: string[]; reviews: ReceiptReview[];
  screenshots: { commit: string; names: string[] }[];
};

export function kindSource(kind: KindProof, head: string) {
  if (kind.state === "ran") return { commit: head, cell: at(head) };
  if (kind.state === "reused") return { commit: kind.from, cell: `${at(head)} (reused from ${at(kind.from)})` };
  if (kind.state === "carried") return { commit: kind.origin ?? kind.from, cell: `${at(head)} (carried from ${at(kind.from)})` };
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
  const models = [...new Set(reviews.flatMap((review) => review.lenses
    ? review.lenses.map((model) => guardModel(`panel model of ${review.label}`, model))
    : review.reviewer ? [guardModel(`reviewer of ${review.label}`, review.reviewer)] : []))];
  const labels = reviews.map((review) => guardField("review label", review.label));
  const lenses = Math.max(0, ...reviews.map((review) => review.lenses?.length ?? 0));
  const who = lenses ? `${lenses}-lens panel (${models.join(", ")})` : `single reviewer (${models.join(", ") || "unnamed"})`;
  const sum = (key: keyof ReviewDisplay["counts"]) => reviews.reduce((total, review) => total + review.counts[key], 0);
  const [first, last] = [reviews[0]!.commit, reviews.at(-1)!.commit];
  return row(["Review", `${who}, ${labels.join(", ")}`, `${sum("findings")} findings: ${sum("fixed")} fixed, ${sum("rejected")} rejected, ${sum("unknown")} other`, first === last ? at(last) : `${at(first)} to ${at(last)}`]);
}

const judgeResults: Record<ProofSummary["judge"]["state"], string> = { pass: "✅ passed at", fail: "❌ failed at", unavailable: "unavailable at", skipped: "not yet run at" };
const judgeRow = ({ judge, commit, code }: ProofSummary) => row(["Proof judge", "an independent model reads the evidence against the diff", `${judgeResults[judge.state]} ${at(commit)}${judge.state === "pass" && code !== 0 ? ", but the gate fails now" : ""}`, ""]);

function acceptedBy(gap: GapProof, decisions: DecisionState[]) {
  const accepted = gap.accepted;
  if (!accepted) return "not accepted";
  if (accepted.by === "standing rule") return "accepted by a standing rule";
  const decision = decisions.find((candidate) => candidate.id === accepted.id);
  return `accepted by ${accepted.mark ? `${accepted.mark} ` : ""}${accepted.by}${decision ? ` ${decision.at.slice(0, 10)}` : ""}`;
}

const gapLines = (input: ReceiptInput) => summaryGaps(input.summary).map(({ kind, gap }) => `${kind}: ${gap.reason ? guardField(`gap reason of ${kind}`, gap.reason) : "no reason recorded"}, ${acceptedBy(gap, input.decisions)}`);

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

export async function screenshotFiles(summary: ProofSummary) {
  return Promise.all(summary.kinds.flatMap((kind) => {
    const from = kind.kind === "ui-walk" ? kindSource(kind, summary.commit) : undefined;
    return from && "directory" in kind ? [readdir(kind.directory).catch(() => [] as string[]).then((names) => ({ commit: from.commit, names }))] : [];
  }));
}

const count = (text: string, part: string) => text.split(part).length - 1;

export function checkMarkers(body: string) {
  const [opens, closes] = [count(body, receiptOpen), count(body, receiptClose)];
  const start = body.indexOf(receiptOpen);
  const whole = start < 0 || new RegExp(`^${marker.source}`).test(body.slice(start));
  if (opens > 1 || closes > 1 || opens !== closes || body.indexOf(receiptClose) < start || !whole) {
    throw new Error(`The PR body holds broken receipt markers (${opens} opening, ${closes} closing). Fix them by hand to one ${receiptOpen} ... --> and one ${receiptClose}, then run the receipt again`);
  }
}

export type Receipt = { head: string; hash: string; section: string };
const blockOf = ({ head, hash, section }: Receipt, heading: string | undefined) => `${receiptOpen} head=${head} hash=${hash} -->\n${heading ? `## ${heading}\n\n` : ""}${section}\n${receiptClose}`;

const blockShape = {
  ...Object.fromEntries(["paragraph", "blockquote", "code", "list", "listItem", "hr", "table", "thead", "tbody", "tr", "th", "td", "html"].map((kind) => [kind, (children: string) => `(${kind}${children})`])),
  heading: (_: string, meta: { level: number }) => `(h${meta.level})`,
  text: () => "",
};
const blocksOf = (text: string) => Bun.markdown.render(text, blockShape);

type Span = { start: number; end: number };

function receiptSpan(text: string): Span | undefined {
  const match = new RegExp(blockText).exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

function blocksAround(text: string, { start, end }: Span) {
  const [shown, before, part] = [blocksOf(text), blocksOf(text.slice(0, start)), blocksOf(text.slice(start, end))];
  return shown.startsWith(before + part) ? before + shown.slice(before.length + part.length) : undefined;
}

function blocksWithout(body: string) {
  const span = receiptSpan(body);
  return span ? blocksAround(body, span) ?? blocksOf(lifted(body, span.start, span.end)) : blocksOf(body);
}

export function keepBody(body: string, placed: string) {
  if (riskCalloutOf(placed) !== riskCalloutOf(body)) {
    throw new Error("Writing the receipt would change the merge-risk callout, because the receipt block holds part of it or lands inside it. Move the callout out of the receipt block and the testing section by hand, then run the receipt again");
  }
  const span = receiptSpan(placed);
  if (!span || blocksAround(placed, span) !== blocksWithout(body)) {
    throw new Error("The receipt would not show as a block of its own, because a code fence, an HTML block or a comment before it stays open, or it would change how GitHub shows the rest of the body. Close the open block by hand, then run the receipt again");
  }
  return placed;
}

export function checkPlacement(body: string, heading: string) {
  checkMarkers(body);
  keepBody(body, placeReceipt(body, { head: "0".repeat(40), hash: "0", section: "" }, heading));
}

type Heading = { start: number; depth: number; title: string };

const atxLine = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))??(?:[ \t]+#+)?[ \t]*$/;
const lineMark = /(\d+)/g;
const topLevelHeadings = {
  ...Object.fromEntries(["paragraph", "blockquote", "code", "list", "hr", "table", "html"].map((kind) => [kind, () => ""])),
  heading: (children: string) => children,
};

function headingsOf(body: string) {
  const lines = body.replace(/[]/g, "").split("\n");
  const marked = lines.map((raw, index) => atxLine.test(raw.replace(/\r$/, "")) ? raw.replace(/\r?$/, (end) => ` ${index}${end}`) : raw);
  const rendered = new Set([...Bun.markdown.render(marked.join("\n"), topLevelHeadings).matchAll(lineMark)].map((match) => Number(match[1])));
  const found: Heading[] = [];
  let start = 0;
  lines.forEach((raw, index) => {
    const atx = atxLine.exec(raw.replace(/\r$/, ""));
    if (atx && rendered.has(index)) found.push({ start, depth: atx[1]!.length, title: atx[2] ?? "" });
    start += raw.length + 1;
  });
  return found;
}

function sectionOf(body: string, heading: string) {
  const headings = headingsOf(body);
  const found = headings.find((candidate) => candidate.title === heading);
  const next = found && headings.find((candidate) => candidate.start > found.start && candidate.depth <= found.depth);
  return { found, next };
}

export function placeReceipt(body: string, receipt: Receipt, heading: string): string {
  const start = body.indexOf(receiptOpen);
  if (start >= 0) {
    const end = body.indexOf(receiptClose) + receiptClose.length;
    const generated = /^[^\n]*-->\r?\n#{1,6}[ \t]+([^\r\n]*?)[ \t]*\r?\n/.exec(body.slice(start, end))?.[1];
    const { found, next } = sectionOf(body, heading);
    const inSection = found !== undefined && found.start < start && (!next || start < next.start);
    const inPlace = body.slice(0, start) + blockOf(receipt, generated) + body.slice(end);
    if ((generated === heading || (generated === undefined && inSection)) && blocksAround(body, { start, end }) !== undefined) return inPlace;
    return placeReceipt(lifted(body, start, end), receipt, heading);
  }
  const { found, next } = sectionOf(body, heading);
  if (next) return `${afterBlankLine(body.slice(0, next.start))}${blockOf(receipt, undefined)}\n\n${body.slice(next.start)}`;
  return `${afterBlankLine(body)}${blockOf(receipt, found ? undefined : heading)}\n`;
}

function lifted(body: string, start: number, end: number) {
  const before = body.slice(0, start);
  const after = body.slice(end);
  return before === "" || /\n[ \t\r]*\n$/.test(before) ? before + after.replace(/^(?:[ \t]*\r?\n)+/, "") : before + after;
}

const afterBlankLine = (text: string) => text === "" || /\n[ \t\r]*\n$/.test(text) ? text : `${text.replace(/\n?$/, "\n")}\n`;
