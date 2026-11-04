import {
  descendants, fetchDiscussionFromGitHub, fetchIssueFromGitHub, issueLink, mapRef, proseLines, splitRepository, tableCell, ticketType,
  type FetchDiscussion, type FetchIssue, type MapIo, type MapRef, type Ticket,
} from "./wayfinder.ts";

const usage = "Usage: fleet decisions <map URL | owner/repo#number | number>";
const whoByMark: Record<string, string> = { "👤": "👤 Human", "👍": "👍 Accepted default", "🤖": "🤖 Agent" };
const whoOrder = Object.values(whoByMark);
const decisionLine = /^\s*[-*]\s*(👤|👍|🤖)️?[\u{1F3FB}-\u{1F3FF}]?\s+\*\*(.+?)\*\*\s*(.+?)\s*$/u;

type Decision = { question: string; answer: string; who: string; where: string; at: string };
type Resolution = { type?: string; rounds: number; decisions: Decision[] };

export async function readDecisions(ref: MapRef, fetchIssue: FetchIssue, fetchDiscussion: FetchDiscussion): Promise<string> {
  const map = await fetchIssue(ref.owner, ref.repo, ref.number);
  const mapBody = (await fetchDiscussion(ref.owner, ref.repo, ref.number)).body;
  const closed = (await descendants(map, fetchIssue)).filter((ticket) => ticket.state !== "OPEN");
  const resolutions: Resolution[] = [];
  for (const ticket of closed) resolutions.push(await resolution(ticket, fetchDiscussion));
  const decisions = [...decisionsIn(mapBody, `[map #${ref.number}](${issueLink(ref)})`, ""), ...resolutions.flatMap((item) => item.decisions)];
  return [...table(byWho(newestPerQuestion(decisions))), "", involvement(resolutions)].join("\n");
}

async function resolution(ticket: Ticket, fetchDiscussion: FetchDiscussion): Promise<Resolution> {
  const [owner, repo] = splitRepository(ticket.repository);
  const { comments } = await fetchDiscussion(owner, repo, ticket.number);
  const rounds = comments.filter((comment) => ticket.assignees.includes(comment.author)).length;
  const decisions = comments.flatMap((comment) => decisionsIn(comment.body, `[#${ticket.number}](${comment.url})`, comment.updatedAt ?? comment.createdAt));
  return { type: ticketType(ticket), rounds, decisions };
}

function decisionsIn(text: string, where: string, at: string): Decision[] {
  return proseLines(text).flatMap((line) => {
    const match = line.match(decisionLine);
    return match ? [{ who: whoByMark[match[1]!]!, question: match[2]!, answer: match[3]!, where, at }] : [];
  });
}

function newestPerQuestion(decisions: Decision[]): Decision[] {
  const byQuestion = new Map<string, Decision>();
  const oldestFirst = decisions.toSorted((left, right) => left.at.localeCompare(right.at));
  for (const decision of oldestFirst) byQuestion.set(decision.question.trim().toLowerCase(), decision);
  return [...byQuestion.values()];
}

function byWho(decisions: Decision[]): Decision[] {
  return decisions.toSorted((left, right) => whoOrder.indexOf(left.who) - whoOrder.indexOf(right.who));
}

function table(decisions: Decision[]): string[] {
  if (!decisions.length) return ["No load-bearing decisions."];
  return ["| Question | Answer | Who | Where |", "| --- | --- | --- | --- |", ...decisions.map(row)];
}

function row({ question, answer, who, where }: Decision): string {
  return `| ${tableCell(question)} | ${tableCell(answer)} | ${who} | ${where} |`;
}

function involvement(resolutions: Resolution[]): string {
  const grillings = resolutions.filter((item) => item.type === "grilling").length;
  const prototypes = resolutions.filter((item) => item.type === "prototype").map((item) => item.rounds);
  const parts = [
    grillings ? `${count(grillings, "grilling")} answered` : "",
    prototypes.length ? `${count(prototypes.length, "prototype")} iterated over ${list(prototypes)} rounds` : "",
  ].filter(Boolean);
  return `Involvement: ${parts.length ? parts.join(", ") : "no human-in-the-loop tickets"}.`;
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

function list(values: number[]): string {
  return values.length === 1 ? String(values[0]) : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

export async function runDecisions(args: string[], io: MapIo): Promise<number> {
  if (args.length !== 1) throw new Error(usage);
  io.print(await readDecisions(mapRef(args[0]!, usage, io.tracker), io.fetchIssue ?? fetchIssueFromGitHub, io.fetchDiscussion ?? fetchDiscussionFromGitHub));
  return 0;
}
