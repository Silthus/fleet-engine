import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { missesPath, proofLedgerRoot } from "./proof-ledger.ts";
import {
  descendants, fetchDiscussionFromGitHub, fetchIssueFromGitHub, issueLink, mapRef, proseLines, splitRepository, tableCell,
  type Comment, type FetchDiscussion, type FetchIssue, type MapIo, type MapRef,
} from "./wayfinder.ts";

export type LessonsIo = MapIo & { home: string; host: string; rolloutLog(): string };
export type PullRequest = { repo: string; pr: number };
export type PrReview = { pr: string; rounds: number; escalations: string[]; misses: string[] };
export type Signals = { review(pr: PullRequest): PrReview; rollouts(pr: PullRequest): string[]; sources: string[] };

export const rolloutLogSetting = "orchestration.rolloutLog";
const usage = "Usage: fleet lessons <map URL | owner/repo#number | number> [--rollouts <file>]";
const failureLine = /^\s*[-*]\s*❌️?\s+\*\*(.+?)\*\*\s*(.+?)\s*$/u;
const pullRequestKey = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g;
const settledRollouts = new Set(["rolled-back", "holding"]);

type Failure = { tried: string; happened: string; where: string };

export async function readLessons(ref: MapRef, fetchIssue: FetchIssue, fetchDiscussion: FetchDiscussion, signals: (pullRequests: PullRequest[]) => Signals): Promise<string> {
  const map = await fetchDiscussion(ref.owner, ref.repo, ref.number);
  const failures = [...failuresIn(map.body, `[map #${ref.number}](${issueLink(ref)})`), ...failuresInComments(map.comments, "map")];
  for (const ticket of await descendants(await fetchIssue(ref.owner, ref.repo, ref.number), fetchIssue)) {
    const [owner, repo] = splitRepository(ticket.repository);
    failures.push(...failuresInComments((await fetchDiscussion(owner, repo, ticket.number)).comments, `#${ticket.number}`));
  }
  const pullRequests = stackPullRequests(map.body);
  return [...failureTable(failures), "", ...signalLines(pullRequests, signals(pullRequests))].join("\n");
}

function failuresInComments(comments: Comment[], label: string): Failure[] {
  return comments.flatMap((comment) => failuresIn(comment.body, `[${label}](${comment.url})`));
}

function failuresIn(text: string, where: string): Failure[] {
  return proseLines(text).flatMap((line) => {
    const match = line.match(failureLine);
    return match ? [{ tried: match[1]!, happened: match[2]!, where }] : [];
  });
}

function failureTable(failures: Failure[]): string[] {
  if (!failures.length) return ["No ❌ lines on the map or its tickets."];
  return ["| Tried | What happened | Where |", "| --- | --- | --- |", ...failures.map(({ tried, happened, where }) => `| ${tableCell(tried)} | ${tableCell(happened)} | ${where} |`)];
}

function stackPullRequests(mapBody: string): PullRequest[] {
  const board = mapBody.split(/^## Stacks\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const keys = new Set([...board.matchAll(pullRequestKey)].map((match) => `${match[1]}#${match[2]}`));
  return [...keys].map((value) => ({ repo: value.split("#")[0]!, pr: Number(value.split("#")[1]) }));
}

function signalLines(pullRequests: PullRequest[], signals: Signals): string[] {
  if (!pullRequests.length) return ["No stack PRs on the map's Stacks board."];
  const unreviewed = pullRequests.filter((pr) => !signals.review(pr).rounds);
  const lines = pullRequests.flatMap((pr) => {
    const { rounds, escalations, misses } = signals.review(pr);
    const parts = [
      ...rounds > 2 ? [`${rounds} review rounds`] : [],
      ...escalations.map((reason) => `arbiter escalated: ${reason}`),
      ...misses.map((finding) => `missed by review: ${finding}`),
      ...signals.rollouts(pr),
    ];
    return parts.length ? [`- ${key(pr)}: ${parts.join("; ")}`] : [];
  });
  return [
    `PR signals from ${signals.sources.join(" and ")}:`,
    ...lines.length || unreviewed.length === pullRequests.length ? lines : ["- none: no stack PR took more than two review rounds or had an escalation, a miss, a hold, or a rollback."],
    ...unreviewed.length ? [`- No proof ledger on this machine has ${unreviewed.map(key).join(", ")}.`] : [],
  ];
}

export function localReview(home: string, pullRequests: PullRequest[]): PrReview[] {
  const misses = jsonLines<{ repo: string; pr: number; finding: string; source: string }>(missesPath(home));
  return pullRequests.map(({ repo, pr }) => {
    const reviews = join(proofLedgerRoot(home), repo, String(pr), "reviews");
    const finished = existsSync(reviews) ? readdirSync(reviews).filter((name) => existsSync(join(reviews, name, "findings.md"))) : [];
    const escalations = finished.flatMap((name) => {
      const round = jsonFile<{ arbiter?: { verdict: string; reason: string } }>(join(reviews, name, "round.json"));
      return round?.arbiter?.verdict === "escalate" ? [`review ${name}: ${round.arbiter.reason}`] : [];
    });
    return {
      pr: key({ repo, pr }), rounds: finished.filter((name) => /^\d+$/.test(name)).length, escalations,
      misses: misses.filter((miss) => miss.repo === repo && miss.pr === pr).map((miss) => `${miss.finding} (${miss.source})`),
    };
  });
}

function rolloutTrouble(rolloutLog: string): (pr: PullRequest) => string[] {
  const rollouts = rolloutLog ? jsonLines<{ repo: string; pr: number; stage: string; state: string; note: string }>(rolloutLog) : [];
  return ({ repo, pr }) => rollouts
    .filter((entry) => entry.repo === repo && entry.pr === pr && settledRollouts.has(entry.state))
    .map((entry) => `rollout ${entry.state} at ${entry.stage}: ${entry.note}`);
}

function rolloutSource(rolloutLog: string): string {
  if (!rolloutLog) return `no rollout log (${rolloutLogSetting} is empty, so holds and rollbacks are unknown)`;
  return existsSync(rolloutLog) ? `the rollout log ${rolloutLog}` : `no rollout log (${rolloutLog} is missing, so holds and rollbacks are unknown)`;
}

const key = ({ repo, pr }: PullRequest) => `${repo}#${pr}`;

function jsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as T]; } catch { return []; }
  });
}

function jsonFile<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

function expandHome(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}

export async function runLessons(args: string[], io: LessonsIo): Promise<number> {
  const [map, flag, file, ...rest] = args;
  if (!map || rest.length || (flag && (flag !== "--rollouts" || !file))) throw new Error(usage);
  const ref = mapRef(map, usage, io.tracker);
  const rolloutLog = expandHome(file ?? io.rolloutLog(), io.home);
  const signals = (pullRequests: PullRequest[]): Signals => {
    const reviews = new Map(localReview(io.home, pullRequests).map((review) => [review.pr, review]));
    return {
      review: (pr) => reviews.get(key(pr))!,
      rollouts: rolloutTrouble(rolloutLog),
      sources: [`the proof ledger on ${io.host}`, rolloutSource(rolloutLog)],
    };
  };
  io.print(await readLessons(ref, io.fetchIssue ?? fetchIssueFromGitHub, io.fetchDiscussion ?? fetchDiscussionFromGitHub, signals));
  return 0;
}
