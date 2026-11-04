import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Gh } from "./gh.ts";

export type BlockerOptions = { repo: string; pr: number; record: boolean };
export type BlockerReport = { output: string; exitCode: 0 | 1 | 2 | 3 };

type Check = { __typename: string; name?: string; context?: string; status?: string; conclusion?: string | null; state?: string };
type PullRequest = { headRefOid: string; isDraft: boolean; mergeable: string; mergeStateStatus: string; reviewDecision: string | null; statusCheckRollup: Check[] | null };
type Blockers = { head: string; failing: string[]; pending: string[]; conflict: boolean; behind: boolean; unknown: boolean; people: string[] };
type Sighting = { head: string; signature: string; at: string };

const usage = "Usage: fleet pr blockers --repo <owner/repo> --pr <number> [--record]";
const failedConclusions = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"]);
const failedStates = new Set(["FAILURE", "ERROR"]);
const pendingStates = new Set(["PENDING", "EXPECTED"]);

export function parseBlockerArgs(args: string[]): BlockerOptions {
  const options: Partial<BlockerOptions> = { record: false };
  const rest = [...args];
  while (rest.length) {
    const arg = rest.shift()!;
    if (arg === "--record") { options.record = true; continue; }
    const value = rest.shift();
    if (arg === "--repo" && value && /^[^/\s]+\/[^/\s]+$/.test(value)) { options.repo = value; continue; }
    if (arg === "--pr" && value && /^\d+$/.test(value)) { options.pr = Number(value); continue; }
    throw new Error(usage);
  }
  if (!options.repo || !options.pr) throw new Error(usage);
  return options as BlockerOptions;
}

export async function prBlockers(options: BlockerOptions, gh: Gh, ledger: string, now: Date): Promise<BlockerReport> {
  const blockers = blockersOf(JSON.parse(await gh(["pr", "view", String(options.pr), "--repo", options.repo, "--json", "headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"])));
  const lines = describe(blockers);
  if (blockers.pending.length || blockers.unknown) return { output: [...lines, "Not settled yet: wait for the checks and GitHub's mergeability, then run it again."].join("\n"), exitCode: 2 };
  const signature = signatureOf(blockers);
  if (!signature) return { output: [...lines, "Nothing an agent can fix blocks the PR."].join("\n"), exitCode: 0 };
  lines.push(`signature: ${signature}`);
  if (!options.record) return { output: lines.join("\n"), exitCode: 1 };
  const path = join(ledger, options.repo, `${options.pr}.jsonl`);
  const earlier = (await readRecords(path)).find((record) => record.signature === signature && record.head !== blockers.head);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify({ head: blockers.head, signature, at: now.toISOString() } satisfies Sighting) + "\n", { mode: 0o600 });
  if (!earlier) return { output: lines.join("\n"), exitCode: 1 };
  lines.push(`No progress: the same blockers stood at ${earlier.head.slice(0, 12)} before the last fix. Read the failing log: a new cause under the same check is progress; the same cause is a question for the user.`);
  return { output: lines.join("\n"), exitCode: 3 };
}

function blockersOf(pr: PullRequest): Blockers {
  const checks = latestPerName(pr.statusCheckRollup ?? []);
  const people = [
    ...pr.reviewDecision === "CHANGES_REQUESTED" ? ["changes requested"] : [],
    ...pr.reviewDecision === "REVIEW_REQUIRED" && !pr.isDraft ? ["review required"] : [],
    ...checks.filter((check) => check.conclusion === "ACTION_REQUIRED").map((check) => `${nameOf(check)} waits for approval`),
  ];
  return {
    head: pr.headRefOid,
    failing: checks.filter(isFailing).map(nameOf).sort(),
    pending: checks.filter(isPending).map(nameOf).sort(),
    conflict: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
    behind: pr.mergeStateStatus === "BEHIND",
    unknown: pr.mergeable === "UNKNOWN",
    people,
  };
}

function latestPerName(checks: Check[]) {
  return [...new Map(checks.map((check) => [nameOf(check), check])).values()];
}

const nameOf = (check: Check) => check.name ?? check.context ?? "unnamed check";
const isFailing = (check: Check) => failedConclusions.has(check.conclusion ?? "") || failedStates.has(check.state ?? "");
const isPending = (check: Check) => check.__typename === "StatusContext" ? pendingStates.has(check.state ?? "") : check.status !== "COMPLETED";

function signatureOf({ failing, conflict }: Blockers) {
  return [...conflict ? ["conflict"] : [], ...failing.map((name) => `failing:${name}`)].join("|");
}

function describe(blockers: Blockers) {
  return [
    `head: ${blockers.head.slice(0, 12)}`,
    ...blockers.failing.map((name) => `failing: ${name}`),
    ...blockers.pending.map((name) => `pending: ${name}`),
    ...blockers.conflict ? ["conflict: the branch conflicts with its base"] : [],
    ...blockers.behind ? ["behind: the base moved; update the branch when the repo requires it"] : [],
    ...blockers.people.map((gate) => `waits on people: ${gate}`),
  ];
}

async function readRecords(path: string): Promise<Sighting[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Sighting);
}
