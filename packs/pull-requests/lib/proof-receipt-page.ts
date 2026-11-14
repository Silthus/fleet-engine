import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { decisionLine, type DecisionState } from "./decision-ledger.ts";
import type { Display } from "./proof-display.ts";
import { storedVerdicts, verdictLines, type JudgeRecord } from "./proof-judge.ts";
import { at, kindSource, type ReceiptReview } from "./proof-receipt.ts";
import type { PublishRequest } from "./proof-receipt-publisher.ts";
import { entries, judgeDirectory, pullRequestDirectory, readJson, reviewedFindings, summaryGaps, type GapProof, type KindProof, type ProofIdentity, type ProofKind, type ProofSummary } from "./proof.ts";

export const receiptBudget = 900_000;

type Lens = { title: string; model: string; seconds?: number; answer?: string; finishedAt?: string };
type Finding = { lens?: string; severity?: string; where?: string; text: string; answer: string };
type Round = { label: string; commit: string; scope: string; base?: string; reviewer?: string; finishedAt?: string; lenses: Lens[]; findings: Finding[]; other?: string };
type Note = { commit: string; name: string; text: string; left: number };
type CommitRow = { commit: string; cells: Partial<Record<ProofKind, string[]>>; review: string[]; judge: string[] };
export type Page = {
  summary: ProofSummary; title: string; decisions: DecisionState[]; display: Display; notChecked: string[];
  commits: CommitRow[]; records: string[]; rounds: Round[]; verdicts: JudgeRecord[]; notes: Partial<Record<ProofKind, Note[]>>;
};
type PageInput = Pick<Page, "summary" | "title" | "decisions" | "display" | "notChecked"> & { reviews: ReceiptReview[] };

const time = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const plain = (text: string) => text.replace(/</g, "&lt;");
const cell = (text: string) => plain(text).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
const row = (cells: string[]) => `|${cells.map((text) => text ? ` ${cell(text)} ` : " ").join("|")}|`;
const table = (head: string[], rows: string[][]) => [row(head), row(head.map(() => "---")), ...rows.map(row)];
const fenced = (text: string) => {
  let longest = 2;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  return [`${fence}text`, text, fence].join("\n");
};

const codeMark = "\uE003";
const indentedLists = 8;
const escaped = (text: string) => text.replace(/[\\`*_[\]~|&]/g, "\\$&");
const unescaped = (text: string) => text.replace(/\\(.)/g, "$1");
const startsBlock = (text: string) => text.replace(/^([ \t]*)([-+>#=]|\d+[.)])/gm, "$1\\$2");
const block = (text: string) => `${startsBlock(text.trim())}\n\n`;
const destination = (url: string) => url.replace(/[\s()<>]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
const indented = (text: string, by: string) => text.trimEnd().split("\n").map((line, index) => index && line ? `${by}${line}` : line).join("\n");

function codeSpan(children: string) {
  const text = unescaped(children);
  const fence = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length)) + 1);
  const pad = /^`|`$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const leadOf = (line: string) => line.replace(/^(?:[^\p{L}\p{N}$]|\d+[.)])+/u, "");

function proseShape(count: (lines: number) => void) {
  let headerCells = 0;
  return {
    text: escaped,
    codespan: codeSpan,
    strong: (children: string) => `**${children}**`,
    emphasis: (children: string) => `_${children}_`,
    strikethrough: (children: string) => `~~${children}~~`,
    link: (children: string, meta: { href: string }) => `[${children}](${destination(meta.href)})`,
    image: (children: string, meta: { src: string }) => `[${children || "image"}](${destination(meta.src)})`,
    paragraph: block,
    html: block,
    heading: (children: string) => `**${children.trim()}**\n\n`,
    hr: () => "\\---\n\n",
    blockquote: (children: string) => `${children.trimEnd().split("\n").map((line) => line ? `> ${line}` : ">").join("\n")}\n\n`,
    list: (children: string, meta: { depth: number }) => meta.depth ? `\n${children}` : `${children}\n`,
    listItem: (children: string, meta: { index: number; depth: number; ordered: boolean; start?: number; checked?: boolean }) => {
      const marker = meta.ordered ? `${(meta.start ?? 1) + meta.index}.` : "-";
      const box = meta.checked === undefined ? "" : meta.checked ? "[x] " : "[ ] ";
      if (meta.depth >= indentedLists) return `${marker} ${box}${children}\n`;
      return `${marker} ${box}${indented(children, " ".repeat(marker.length + 1))}\n`;
    },
    table: (children: string) => `${children}\n`,
    thead: (children: string) => { const delimiter = `|${" --- |".repeat(headerCells)}\n`; headerCells = 0; return `${children}${delimiter}`; },
    tr: (children: string) => `|${children}\n`,
    th: (children: string) => { headerCells++; return ` ${children.replace(/\n/g, " ")} |`; },
    td: (children: string) => ` ${children.replace(/\n/g, " ")} |`,
    code: (children: string) => { count(children.split("\n").filter((line) => /\S/.test(line)).length); return `${codeMark}\n\n`; },
  };
}

export function proseOf(text: string) {
  let left = 0;
  const lines = Bun.markdown.render(text, proseShape((lines) => { left += lines; })).split("\n");
  const firstCommand = lines.findIndex((line) => leadOf(line).startsWith("$ "));
  const prose = firstCommand === -1 ? lines : lines.slice(0, firstCommand);
  for (const line of lines.slice(prose.length)) if (/\S/.test(line) && !line.includes(codeMark)) left++;
  const kept = prose.filter((line) => {
    if (line.includes(codeMark)) return false;
    if (!leadOf(line).startsWith("exit=")) return true;
    left++;
    return false;
  });
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), left };
}

const severities = ["blocker", "major", "minor", "nit", "high", "medium", "low"];

function findingOf(text: string, answer: string): Finding {
  const body = text.replace(/^(?:[-*]|\d+\.)\s+/, "");
  const parts = body.split(" | ");
  if (parts.length >= 4 && severities.includes(parts[1]!.trim().toLowerCase())) {
    return { lens: parts[2]!.trim(), severity: parts[1]!.trim().toLowerCase(), where: parts[0]!.trim(), text: parts.slice(3).join(" | ").trim(), answer };
  }
  const severity = /^\*\*([a-z]+)\*\*(?:,|\s+[—–-])?\s*/i.exec(body);
  const rest = severity ? body.slice(severity[0].length) : body;
  const where = severity ? /^`([^`]+)`:?\s*/.exec(rest) : null;
  return { ...severity ? { severity: severity[1]!.toLowerCase() } : {}, ...where ? { where: where[1] } : {}, text: where ? rest.slice(where[0].length) : rest, answer };
}

async function roundsOf(reviews: ReceiptReview[]): Promise<Round[]> {
  return Promise.all(reviews.map(async (review) => {
    const { directory } = review;
    const reserved = await readJson<{ scope?: string; base?: string } | undefined>(join(directory, "round.json"), undefined);
    const lenses = await Promise.all((review.lenses ?? []).map(async (lens): Promise<Lens> => {
      const status = await readJson<{ startedAt?: string; finishedAt?: string } | undefined>(join(directory, "lenses", `${lens.name}.json`), undefined);
      const answer = await readFile(join(directory, "lenses", `${lens.name}.md`), "utf8").catch(() => undefined);
      const seconds = status?.startedAt && status.finishedAt ? Math.round((Date.parse(status.finishedAt) - Date.parse(status.startedAt)) / 1000) : undefined;
      return { title: lens.title, model: lens.model, ...seconds !== undefined ? { seconds } : {}, ...answer !== undefined ? { answer } : {}, ...status?.finishedAt ? { finishedAt: status.finishedAt } : {} };
    }));
    const findings = review.findings.map((finding) => findingOf(finding.text, finding.answer ? finding.answer.text.replace(/^\s*(?:[-*]\s+)?\d+[.):]\s+/, "") : "unknown"));
    const finished = lenses.map((lens) => lens.finishedAt).filter((value): value is string => !!value).sort().at(-1);
    return {
      label: review.label, commit: review.commit, scope: reserved?.scope ?? "full", ...reserved?.base ? { base: reserved.base } : {}, ...review.reviewer ? { reviewer: review.reviewer } : {},
      ...finished ? { finishedAt: finished } : {}, lenses, findings, ...review.other ? { other: review.other } : {},
    };
  }));
}

async function notesOf(directory: string, commit: string) {
  const names = (await entries(directory)).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(names.map(async (name) => ({ commit, name, ...proseOf(await readFile(join(directory, name), "utf8")) })));
}

export async function gatherPage(home: string, head: ProofIdentity, input: PageInput): Promise<Page> {
  const { summary } = input;
  const directory = pullRequestDirectory(home, head);
  const owed = summary.kinds.map((kind) => kind.kind);
  const rows = new Map<string, CommitRow>();
  const rowOf = (commit: string) => rows.get(commit) ?? rows.set(commit, { commit, cells: {}, review: [], judge: [] }).get(commit)!;
  const add = (commit: string, kind: ProofKind, text: string) => ((rowOf(commit).cells[kind] ??= []).push(text));
  for (const commit of (await entries(directory)).filter((name) => /^[0-9a-f]{40}$/.test(name))) {
    for (const kind of owed) if ((await entries(join(directory, commit, kind))).length) add(commit, kind, "saved");
  }
  const records: string[] = [];
  for (const kind of owed) {
    for (const file of (await entries(join(directory, "reused", kind))).filter((name) => name.endsWith(".json")).sort()) {
      const reuse = await readJson<{ from: string; reason: string } | undefined>(join(directory, "reused", kind, file), undefined);
      if (!reuse) continue;
      const commit = file.slice(0, -5);
      add(commit, kind, `reused from ${at(reuse.from)}`);
      records.push(`- ${at(commit)} ${kind} reused from ${at(reuse.from)}: ${plain(reuse.reason)}`);
    }
  }
  for (const kind of summary.kinds) {
    if (kind.state === "carried") {
      add(summary.commit, kind.kind, `carried from ${at(kind.from)}`);
      records.push(`- ${at(summary.commit)} ${kind.kind} carried from ${at(kind.from)} across ${kind.merges} clean merge(s) of the base`);
    }
    if (kind.state === "gap") add(summary.commit, kind.kind, "gap");
  }
  for (const review of input.reviews) rowOf(review.commit).review.push(review.label);
  const verdicts = await storedVerdicts(judgeDirectory(home, head));
  for (const verdict of verdicts) rowOf(verdict.commit).judge.push(verdict.passed ? "✅" : "❌");
  rowOf(summary.commit);
  const times = new Map<string, number>();
  const seen = (commit: string, time: number) => times.set(commit, Math.min(times.get(commit) ?? Infinity, time));
  for (const commit of rows.keys()) seen(commit, await stat(join(directory, commit)).then((info) => info.mtimeMs, () => Infinity));
  for (const review of input.reviews) seen(review.commit, await stat(join(review.directory, "findings.md")).then((info) => info.mtimeMs, () => Infinity));
  for (const verdict of verdicts) seen(verdict.commit, Date.parse(verdict.judgedAt));
  const commits = [...rows.values()].sort((a, b) => Number(a.commit === summary.commit) - Number(b.commit === summary.commit) || times.get(a.commit)! - times.get(b.commit)! || a.commit.localeCompare(b.commit));
  const notes: Page["notes"] = {};
  for (const kind of summary.kinds) {
    const from = kindSource(kind, summary.commit);
    if (from && "directory" in kind) notes[kind.kind] = await notesOf(kind.directory, from.commit);
  }
  const { reviews, ...rest } = input;
  return { ...rest, commits, records, rounds: await roundsOf(reviews), verdicts, notes };
}

const cuts = ["raw lens answers", "judge reasons", "evidence notes past their first 40 lines"] as const;
type Cut = (typeof cuts)[number];
const noteLines = 40;

function gapRow({ kind, gap }: { kind: string; gap: GapProof }, decisions: DecisionState[]) {
  const decision = gap.accepted?.id ? decisions.find((candidate) => candidate.id === gap.accepted!.id) : undefined;
  const who = !gap.accepted ? "not accepted" : gap.accepted.by === "standing rule" ? "a standing rule" : `${gap.accepted.mark ? `${gap.accepted.mark} ` : ""}${gap.accepted.by}`;
  return [kind, gap.commit ? at(gap.commit) : "", gap.reason ?? "no reason recorded", decision?.question ?? "", decision?.answer ?? "", who, decision ? time(decision.at) : "", decision?.where.thread ?? ""];
}

const sentence = (text: string) => /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
const duration = (seconds: number) => seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`;
const answerOf = (record: JudgeRecord, name: "proof" | "owed" | "review" | "risk") => record.verdict?.[name]?.verdict ?? "";
const qualityOf = (record: JudgeRecord) => !record.verdict?.quality ? "" : record.verdict.quality.findings.some((finding) => finding.rating === "high") ? "fail" : "pass";

function noteText(note: Note, cut: boolean) {
  const lines = note.text.split("\n");
  const shown = cut && lines.length > noteLines ? [...lines.slice(0, noteLines), "", `[${lines.length - noteLines} more lines left out to fit the page]`] : lines;
  return [`#### Note \`${note.name}\` at ${at(note.commit)}`, "", ...shown.map(plain), ...note.left ? ["", `[${note.left} lines of command output left out]`] : [], ""];
}

const kindHeadings: Record<ProofKind, string> = {
  "live-run": "Live run", "ui-walk": "UI walk", "prod-shape": "Production shape", "cross-version": "Cross-version", "shadow-diff": "Shadow diff", "post-deploy-watch": "Post-deploy watch",
};

function kindPart(page: Page, proof: KindProof, cut: boolean) {
  const kind = proof.kind;
  const from = kindSource(proof, page.summary.commit);
  const lines = from ? page.display.lines[from.commit]?.[kind] : undefined;
  const notes = page.notes[kind] ?? [];
  if (!lines && !notes.length) return [];
  return [`## ${kindHeadings[kind]}`, "", ...lines ? [plain(`**What ran:** ${sentence(lines.ran)} **Result:** ${sentence(lines.result)}`), ""] : [], ...notes.flatMap((note) => noteText(note, cut))];
}

function roundPart(round: Round, applied: readonly Cut[]) {
  const out = [plain(`### ${round.label[0]!.toUpperCase()}${round.label.slice(1)} at ${at(round.commit)}`), "",
    plain(`Scope ${round.scope}, base ${round.base ? at(round.base) : "the PR's base"}, reviewer ${round.reviewer ?? "unnamed"}${round.finishedAt ? `, finished ${time(round.finishedAt)}` : ""}.`), ""];
  if (round.lenses.length) out.push(...table(["Lens", "Model", "Time taken", "Findings"], round.lenses.map((lens) => [
    lens.title, lens.model, lens.seconds !== undefined ? duration(lens.seconds) : "", lens.answer === undefined ? "no answer" : String(reviewedFindings(lens.answer).length),
  ])), "");
  if (round.findings.length) out.push(...table(["#", "Severity", "Lens", "Where", "Finding", "Answer"], round.findings.map((finding, index) => [
    String(index + 1), finding.severity ?? "", finding.lens ?? "", finding.where ? `\`${finding.where}\`` : "", finding.text, finding.answer,
  ])), "");
  if (round.other) out.push("Other answers, as written:", "", fenced(round.other), "");
  if (!applied.includes("raw lens answers")) {
    for (const lens of round.lenses.filter((candidate) => candidate.answer !== undefined)) {
      out.push("<details>", `<summary>Raw answer of the ${plain(lens.title)} lens, by ${plain(lens.model)}</summary>`, "", fenced(lens.answer!.trim()), "", "</details>", "");
    }
  }
  return out;
}

function judgePart(page: Page, atHead: JudgeRecord | undefined, applied: readonly Cut[]) {
  const out = ["## Judge verdicts", ""];
  if (!atHead) out.push(`> No judge run is stored at HEAD ${at(page.summary.commit)}.`, "");
  if (!page.verdicts.length) return out;
  out.push(...table(["Run", "Commit", "Model", "Judged", "Proof", "Owed", "Review", "Risk", "Quality", "Gate"], page.verdicts.map((verdict, index) => [
    String(index + 1), at(verdict.commit), verdict.model, time(verdict.judgedAt), answerOf(verdict, "proof"), answerOf(verdict, "owed"),
    answerOf(verdict, "review"), answerOf(verdict, "risk"), qualityOf(verdict), verdict.passed ? "✅" : "❌",
  ])), "");
  if (!applied.includes("judge reasons")) {
    page.verdicts.forEach((verdict, index) => {
      if (verdict.verdict?.quality) out.push("<details>", `<summary>Run ${index + 1} reasons</summary>`, "", ...verdictLines(verdict.verdict).map((line) => `- ${plain(line)}`), "", "</details>", "");
    });
  }
  const escalations = page.verdicts.flatMap((verdict, index) => verdict.escalation ? [`- Run ${index + 1} escalated: ${plain(verdict.escalation)}`] : []);
  if (escalations.length) out.push("Escalations:", "", ...escalations, "");
  return out;
}

function judgeAtHead(summary: ProofSummary, stored: JudgeRecord | undefined) {
  const by = stored ? ` (${stored.model}, ${time(stored.judgedAt)})` : "";
  if (summary.judge.state === "pass") return `✅ passed${by}${summary.code !== 0 ? ", but the gate fails now" : ""}`;
  if (summary.judge.state === "fail") return `❌ failed${by}`;
  return summary.judge.state === "unavailable" ? "unavailable" : "not yet run";
}

export function renderPage(page: Page, applied: readonly Cut[] = []) {
  const { summary } = page;
  const ref = `${summary.repository}#${summary.pr}`;
  const atHead = page.verdicts.filter((verdict) => verdict.commit === summary.commit).at(-1);
  const judgeState = judgeAtHead(summary, atHead);
  const owed = summary.kinds.map((kind) => kind.kind);
  const notesCut = applied.includes("evidence notes past their first 40 lines");
  const gaps = summaryGaps(summary);
  const out: string[] = [
    `# Proof receipt: ${ref}`, "", `[${ref}](https://github.com/${summary.repository}/pull/${summary.pr}): ${plain(page.title)}`, "",
    `**HEAD:** ${at(summary.commit)}  `, `**Owed:** ${owed.join(", ") || "none"}  `, `**Judge at HEAD:** ${judgeState}`, "",
    ...applied.length ? [...applied.map((cut) => `> Left out to fit the page: ${cut}.`), ""] : [],
    "## Proof by commit", "", ...table(["Commit", ...owed, "Review", "Judge"], page.commits.map((commit) => [
      at(commit.commit), ...owed.map((kind) => (commit.cells[kind] ?? []).join("; ")), commit.review.join(", "), commit.judge.join(" "),
    ])), "",
    ...page.records.length ? ["Reuse and carry records:", "", ...page.records, ""] : [],
    ...page.rounds.length ? ["## Review rounds", "", ...page.rounds.flatMap((round) => roundPart(round, applied))] : [],
    ...judgePart(page, atHead, applied),
    ...gaps.length ? ["## Gaps and who accepted them", "", ...table(["Kind", "Commit", "Why", "Question", "Answer", "Who", "When", "Thread"], gaps.map((gap) => gapRow(gap, page.decisions))), ""] : [],
    ...page.display.screenshots.length ? ["## Screenshots in journey order", "", ...page.display.screenshots.map((shot, index) =>
      `${index + 1}. ${shot.url ? `[${plain(shot.caption)}](${shot.url})` : `${plain(shot.caption)} (not published)`} at ${at(shot.commit)}, evidence \`${shot.name}\``), ""] : [],
    ...summary.kinds.flatMap((kind) => kindPart(page, kind, notesCut)),
    ...page.decisions.length ? ["## Decisions", "", ...page.decisions.map((decision) => plain(decisionLine(decision))), ""] : [],
    ...page.notChecked.length ? ["## Not checked", "", ...page.notChecked.map((item) => `- ${plain(item)}`), ""] : [],
  ];
  return `${out.join("\n").trimEnd()}\n`;
}

export class PageTooLarge extends Error {}

export function fitPage(page: Page, metadata: Omit<PublishRequest, "page">) {
  let bytes = 0;
  for (let applied = 0; applied <= cuts.length; applied++) {
    const fitted: PublishRequest = { ...metadata, page: renderPage(page, cuts.slice(0, applied)) };
    bytes = Buffer.byteLength(JSON.stringify(fitted));
    if (bytes < receiptBudget) return fitted;
  }
  throw new PageTooLarge(`receipt refused: the full receipt is ${bytes} bytes after every cut, over the budget of ${receiptBudget} bytes. Shorten the evidence notes or the lens answers.`);
}
