import { createHash } from "node:crypto";
import { access, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { normalized, type HeardAnswer } from "./proof-answers.ts";
import { agentRefusal, agentsAcceptance, covers, fold, keptOwed, panelRefusal, usersAcceptance, type Decision, type DecisionState, type Ledger, type Mark, type PrRef, type Tier } from "./decision-ledger.ts";
import type { Family, Usage } from "./proof-models.ts";
import { quietReason, type DeltaKind, type QuietStep } from "./proof-delta.ts";
import { isProductionFile } from "./proof-checkout.ts";
import { panelOutcome, unansweredPanelCause } from "./proof-panel.ts";
import { redactSecrets } from "../../base/hooks/secret-guard.ts";
import { anchorHeading } from "./finding-anchors.ts";
import type { Growth } from "./proof-end-table.ts";
import { endTableNote, gradeOf, shellQuoted, type Autonomy } from "./proof-autonomy.ts";

export type ProofIdentity = { repository: string; pr: number; commit: string };
const sha = /^[0-9a-f]{40}$/;
export const ledgerRoot = (home: string) => join(home, ".local/state/hedge/proof");

export function prDirectory(home: string, { repository, pr }: PrRef) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..")) throw new Error(`Invalid repository ${repository || "(none)"}. Use owner/name`);
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("Use a positive PR number and a full commit SHA");
  return join(ledgerRoot(home), repository, String(pr));
}

export function pullRequestDirectory(home: string, identity: ProofIdentity) {
  const directory = prDirectory(home, identity);
  if (!sha.test(identity.commit)) throw new Error("Use a positive PR number and a full commit SHA");
  return directory;
}

export function proofDirectory(home: string, identity: ProofIdentity) {
  return join(pullRequestDirectory(home, identity), identity.commit);
}

export type GateRecord = { code: number; reason: string };

export const gateRunDirectory = (home: string, identity: ProofIdentity) =>
  join(pullRequestDirectory(home, { ...identity, repository: identity.repository.toLowerCase() }), "gate-record", identity.commit);

const unfinishedGateRun: GateRecord = { code: 1, reason: "the gate run has not finished: it still runs, or it stopped without a result" };

const gateRunNames = async (directory: string) =>
  (await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })).filter((name) => /^\d+\.json$/.test(name));

async function lastRunNumber(directory: string): Promise<number> {
  return Math.max(0, ...(await gateRunNames(directory)).map((name) => parseInt(name, 10)));
}

export async function startGateRun(home: string, identity: ProofIdentity, startedAt = new Date()): Promise<(record: GateRecord) => Promise<void>> {
  const started = { startedAt: startedAt.toISOString() };
  const directory = gateRunDirectory(home, identity);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (let number = await lastRunNumber(directory) + 1; ; number++) {
    const path = join(directory, `${number}.json`);
    try {
      await writeFile(path, JSON.stringify({ ...unfinishedGateRun, ...started }) + "\n", { flag: "wx", mode: 0o600 });
      return (record) => writeJson(path, { ...record, ...started });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export type GateResult = { passed: boolean; at: number };

export const latestGateResult = (results: GateResult[]) => results.toSorted((a, b) => a.at - b.at || Number(b.passed) - Number(a.passed)).at(-1);

export async function lastGateResult(home: string, identity: ProofIdentity): Promise<GateResult | undefined> {
  const directory = gateRunDirectory(home, identity);
  const results = await Promise.all((await gateRunNames(directory)).map(async (name) => {
    const { code, startedAt } = (await readJson<{ code?: unknown; startedAt?: unknown } | null>(join(directory, name), null)) ?? {};
    const at = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
    return Number.isNaN(at) ? { passed: false, at: -Infinity } : { passed: code === 0, at };
  }));
  return latestGateResult(results);
}

export async function lastGateRun(home: string, identity: ProofIdentity): Promise<GateRecord | undefined> {
  const directory = gateRunDirectory(home, identity);
  const last = await lastRunNumber(directory);
  if (!last) return undefined;
  const { code, reason } = (await readJson<Partial<GateRecord> | null>(join(directory, `${last}.json`), null)) ?? {};
  if (!Number.isInteger(code) || typeof reason !== "string") throw new Error(`Malformed gate record ${last}.json in ${directory}`);
  return { code: code!, reason };
}

const screenshotSignatures = [
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("ffd8ff", "hex"),
  Buffer.from("GIF87a"),
  Buffer.from("GIF89a"),
];

export function isScreenshot(path: string, bytes: Buffer): boolean {
  if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(path)) return false;
  const webp = bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  return webp || screenshotSignatures.some((signature) => bytes.subarray(0, signature.length).equals(signature));
}

export const uiWalkRule = "A UI walk keeps only screenshots of the running app";

export async function saveProof(home: string, identity: ProofIdentity, source: string, kind?: string): Promise<string> {
  const bytes = await readFile(source);
  if (!bytes.length) throw new Error(`${source} is empty. Save the output that shows the behavior`);
  const extension = extname(source).toLowerCase();
  if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw new Error("Proof files need a simple file extension");
  if (kind === "ui-walk" && !isScreenshot(source, bytes)) throw new Error(uiWalkRule);
  const name = createHash("sha256").update(bytes).digest("hex") + extension;
  const directory = kind === undefined ? proofDirectory(home, identity) : join(proofDirectory(home, identity), proofKind(kind));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, name);
  try { await writeFile(destination, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return destination;
}

type Reuse = { from: string; reason: string; recordedAt: string };
const reusePath = (home: string, identity: ProofIdentity, kind: ProofKind) => join(pullRequestDirectory(home, identity), "reused", kind, `${identity.commit}.json`);

export async function reuseProof(home: string, identity: ProofIdentity, kind: string, from: string, reason: string) {
  const owed = proofKind(kind);
  if (!reason.trim()) throw new Error("--reuse-from needs --reason with why the evidence of that commit still proves HEAD");
  if (from === identity.commit) throw new Error("That commit is HEAD. Save its evidence instead");
  if (!(await provedCommits(home, identity, owed)).has(from)) throw new Error(`${short(from)} has no ${owed} evidence to reuse`);
  const reuse: Reuse = { from: (await provedCommits(home, identity, owed)).get(from)?.reuse?.from ?? from, reason, recordedAt: new Date().toISOString() };
  await writeJson(reusePath(home, identity, owed), reuse);
  return reuse;
}

export type LockRound = (directory: string) => Promise<void>;
export type LockBudget = <T>(reviews: string, step: () => Promise<T>) => Promise<T>;

async function reserve(reviews: string, name: string, record: object, { lock, now }: Stamping) {
  const temporary = join(reviews, `.reservation-${crypto.randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await lock?.(temporary);
    await writeFile(join(temporary, "round.json"), JSON.stringify({ ...record, reservationId: crypto.randomUUID(), startedAt: now().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, join(reviews, name));
    return true;
  } catch (error) {
    if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

const finalReadPrefix = "final-";
const finalReadPhases = ["review", "babysit"] as const;
type FinalReadPhase = (typeof finalReadPhases)[number];

const isReviewName = (name: string) => /^(\d+|final-\d+)$/.test(name);
const reviewNames = async (reviews: string) => (await entries(reviews)).filter(isReviewName);

function finalReadPhase(value: string): FinalReadPhase {
  if (!(finalReadPhases as readonly string[]).includes(value)) throw new Error("Final read phase must be review or babysit");
  return value as FinalReadPhase;
}

type Spending = "unfinished spends" | "finished only";
type Spent = { spent: number; names: string[]; reservations: string[]; finished: string[]; round?: number; counted?: string[] };
type ReservedAs = { reservationId?: string; startedAt?: string; commit?: string; scope?: string; phase?: FinalReadPhase };
const reservationOf = ({ reservationId, startedAt, commit, scope, phase }: ReservedAs) => JSON.stringify([reservationId, startedAt, commit, scope, phase]);

async function savedFindings(directory: string) {
  try { return await readFile(join(directory, "findings.md"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function reviewsSpent(reviews: string, phase: FinalReadPhase, spending: Spending, dropping: string[] = []): Promise<Spent> {
  const rounds = await Promise.all((await reviewNames(reviews)).filter((name) => !dropping.includes(name)).map(async (name) => {
    const round = await readJson<ReservedAs | undefined>(join(reviews, name, "round.json"), undefined);
    if (!round) return undefined;
    const findings = await savedFindings(join(reviews, name));
    const leadsToFixes = findings === undefined ? spending === "unfinished spends" : unanswered(findings, "").length > 0;
    return { name, reservation: reservationOf(round), finished: findings !== undefined, spends: (round.phase ?? "review") === phase && leadsToFixes };
  }));
  const present = rounds.filter((round) => round !== undefined).sort((a, b) => a.name.localeCompare(b.name));
  return { spent: present.filter(({ spends }) => spends).length, names: present.map(({ name }) => name), reservations: present.map(({ reservation }) => reservation), finished: present.filter(({ finished }) => finished).map(({ name }) => name) };
}

const budgetState = ({ spent, names, reservations, finished, round, counted }: Spent) => JSON.stringify([spent, names, reservations, finished, round, counted]);

async function reserveWeighed<T extends Spent>(reviews: string, lockBudget: LockBudget, snapshot: () => Promise<T>, permit: (weighed: T) => Promise<ArbiterVerdict | undefined>, reserveIt: (weighed: T, verdict: ArbiterVerdict | undefined) => Promise<Reserved>) {
  const before = await lockBudget(reviews, snapshot);
  const verdict = await permit(before);
  return lockBudget(reviews, async () => {
    const after = await snapshot();
    const started = after.names.filter((name) => !before.names.includes(name));
    if (started.length) throw new Error(`Review ${started.join(", ")} started while this one weighed the budget. ${weighAgain}`);
    if (budgetState(after) !== budgetState(before)) throw new Error(`The reviews changed while this one weighed the budget. ${weighAgain}`);
    return reserveIt(before, verdict);
  });
}

const weighAgain = "Run this command again to weigh it anew";

export type ArbiterVerdict = { verdict: "continue" | "escalate" | "unavailable"; reason: string; model: string };
export type Arbiter = (prompt: string) => Promise<ArbiterVerdict>;

const arbiterInstructions = `You decide if a code review loop may run one more review. Below are the findings of every finished review of one pull request, oldest first, each with the author's responses when there are any. A panel review has one section per lens.

Answer ESCALATE only in one of these cases:
1. A later finding asks to undo, or contradicts, what an earlier finding asked for. The reviewers disagree, so a human must choose.
2. The same finding comes back in a later review after it was reported and fixed. The loop does not converge.

hedge ends some findings with an Anchor check. Its "Seen before" lines name findings that quote the same changed line as a finding of an earlier review: weigh them for case 2.

Only open blockers and majors count. The findings below leave out minor and nit findings, which need no response, and every TESTS block, whose items get a test-only fix. None of them needs a new read.

In all other cases answer CONTINUE. New findings, many findings, or findings about new code are not a reason to escalate. A finding whose earlier fix the author's response moved into the module that owns the concept is progress, not a loop.

Your first line must be exactly CONTINUE, or ESCALATE: followed by one sentence that names the findings and their reviews. Write nothing else.`;
const findingsCap = 16_000;
const responsesCap = 4000;
const cut = (text: string, cap: number) => text.length > cap ? text.slice(0, cap) + "\n[truncated]" : text;

async function arbiterPrompt(home: string, identity: ProofIdentity) {
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  const sections = await Promise.all((await finishedReviews(home, identity)).map(async ({ name }) => {
    const findings = ladderFindings(await readFile(join(reviews, name, "findings.md"), "utf8")).trim();
    const responses = (await readFile(join(reviews, name, "responses.md"), "utf8").catch(() => "")).trim();
    return `# ${reviewLabel(name)}\n\n${cut(findings, findingsCap)}${responses ? `\n\n# Responses to ${reviewLabel(name)}\n\n${cut(responses, responsesCap)}` : ""}`;
  }));
  return [arbiterInstructions, ...sections].join("\n\n");
}

const namesEscalate = (output: string) => /escalate/i.test(output);

export function parseVerdict(output: string, model: string): ArbiterVerdict {
  const line = (output.split("\n").find((text) => text.trim()) ?? "").replace(/^[\s*`]+|[\s*`]+$/g, "");
  if (/^CONTINUE(?::\s*\S.*)?$/.test(line)) return namesEscalate(output) ? { verdict: "unavailable", reason: "the answer says CONTINUE and also ESCALATE", model } : { verdict: "continue", reason: "", model };
  const escalate = /^ESCALATE:\s*(\S.*)$/.exec(line);
  if (escalate) return { verdict: "escalate", reason: escalate[1]!.replace(/\.$/, ""), model };
  return { verdict: "unavailable", reason: `unparseable answer: ${line.slice(0, 200)}`, model };
}

export type ReviewLimits = { free: number; ceiling: number };

export const atCeiling = `hedge proof asks nothing more. For each open blocker or major, revert the fix that brought it in, or list it in a "## Known issues" section of the PR body, one "- <blocker|major>: <file:line> <finding>" item each, and answer its finding "<n>. known: <why>". A blocker or major that the last read found in the fixes since the panel is reverted, never listed. An open blocker holds the merge; the user's merge word accepts the rest. Only the user's --override runs another review, or a final read of a HEAD that the gate does not carry`;

const budgetSpent = ({ ceiling }: ReviewLimits) => `The review budget of ${ceiling} reviews is spent. ${atCeiling}`;

async function permitReview(home: string, identity: ProofIdentity, due: boolean, ceiling: string | undefined, decision: DecisionMark | undefined, { arbiter, autonomy }: Permit) {
  if (decision?.mark === "👤") return undefined;
  if (ceiling) throw new Error(ceiling);
  if (!due) return undefined;
  const verdict = await arbiter(await arbiterPrompt(home, identity));
  if (verdict.verdict !== "continue" && !decision) throw new Error(askUser(identity, verdict.verdict === "escalate" ? `The arbiter escalates: ${verdict.reason}.` : `The arbiter gave no verdict: ${verdict.reason}.`, autonomy?.() ?? "ask"));
  return verdict;
}

export const roundQuestion = "Run one more review round?";
export const runOption = "Run one more round";
export const stopOption = "Stop here";

function askUser(identity: ProofIdentity, stop: string, autonomy: Autonomy) {
  if (autonomy === "end") return `${stop} Decide the round yourself: run this command again with --agent '<your reason>'. It lands in the ledger as a 🤖 review decision, and ${endTableNote}.`;
  const ask = `${stop} Ask the user with your question tool. Question: "${roundQuestion} ${identity.repository}#${identity.pr}: ${stop}" Options: "${runOption}", "${stopOption}". When they choose "${runOption}", run this command again with --override '<date> "${runOption}"'.`;
  return autonomy === "user" ? `${ask} On a one-way door an agent never decides the round.` : `${ask} Or decide the round yourself with --agent '<your reason>', a 🤖 review decision in the ledger, when the PR's tier lets you.`;
}

export type CapturedBy = "hedge" | "author";
export type DecisionMark = Pick<Decision, "mark" | "id">;
export type DropRead = (directory: string) => Promise<boolean>;
export type ReviewRequest = { dropUnanswered?: DropRead; autonomy?: () => Autonomy; opening?: () => Promise<boolean>; sanity?: () => Promise<void>; scope: string; base?: string; from?: string; forkBase?: string; decision?: Decision; phase?: string; arbiter: Arbiter; limits: ReviewLimits; cleanBaseMerge?: CleanBaseMerge; quietCommit?: QuietCommit; capturedBy?: CapturedBy; lock?: LockRound; lockBudget: LockBudget; now: () => Date };
export type Reserved = { round: number | "final"; id: string; directory: string };
type Permit = { arbiter: Arbiter; limits: ReviewLimits; autonomy?: () => Autonomy };

async function reserveDecided(reviews: string, name: string, record: object, decision: Decision | undefined, stamping: Stamping) {
  if (!await reserve(reviews, name, { ...record, ...decision ? { decision } : {} }, stamping)) throw new Error(`Review ${name} started while this one weighed the budget. ${weighAgain}`);
}

type Stamping = { lock: LockRound | undefined; now: () => Date };
type Reserving = Stamping & { lockBudget: LockBudget; dropUnanswered?: DropRead };

async function droppableReads(reviews: string, identity: ProofIdentity, dropUnanswered: DropRead | undefined) {
  if (!dropUnanswered) return [];
  const names = await reviewNames(reviews);
  const unanswered = await Promise.all(names.map((name) => unansweredFinalRead(join(reviews, name), identity)));
  return names.filter((_, index) => unanswered[index]);
}

async function startFinalRead(home: string, identity: ProofIdentity, base: string | undefined, decision: Decision | undefined, phase: FinalReadPhase, permit: Permit, cleanBaseMerge: CleanBaseMerge, quietCommit: QuietCommit, capturedBy: CapturedBy, from: string | undefined, { lockBudget, dropUnanswered, ...stamping }: Reserving): Promise<Reserved> {
  if (base === undefined) throw new Error("A final read needs --base with the latest reviewed commit");
  if (base === identity.commit) throw new Error("HEAD is already reviewed. Skip the final read.");
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  const { free, ceiling } = permit.limits;
  const snapshot = async () => {
    const dropping = await droppableReads(reviews, identity, dropUnanswered);
    const counted = await finishedReviews(home, identity);
    return { ...await reviewsSpent(reviews, phase, "unfinished spends", dropping), reviews: counted, counted: counted.map(({ name }) => name), dropping };
  };
  const permitRead = async ({ spent, names, finished: saved, reviews: finished }: Awaited<ReturnType<typeof snapshot>>) => {
    const carried = gateCarry(identity, finished, cleanBaseMerge, quietCommit).found;
    const latest = finished.at(-1);
    if (!latest) throw new Error("A final read needs a finished earlier review");
    if (!coversReview(base, latest.commit, cleanBaseMerge)) throw new Error(`Final read base must be the latest reviewed commit ${latest.commit}, or a clean base merge the gate carried it to`);
    const unfinished = (await Promise.all(names.map(async (name) => !saved.includes(name) || await panelOutcome(join(reviews, name)) === "unfinished"))).some(Boolean);
    const retry = unfinished ? "" : ` To read it anyway, pass ${spent < ceiling ? "--agent '<your reason>', or " : ""}the user's --override`;
    if (!decision && carried?.quiet.length) throw new Error(`HEAD needs no final read: final read carried from ${short(carried.from)}: ${quietReason(carried.kinds)}. hedge proof gate counts the carry.${retry}`);
    if (unfinished) throw new Error("A review is unfinished. Finish it before a final read.");
    return permitReview(home, identity, spent >= free, carried && spent >= ceiling ? budgetSpent(permit.limits) : undefined, decision, permit);
  };
  return reserveWeighed(reviews, lockBudget, snapshot, permitRead, async ({ dropping }, verdict) => {
    for (const name of dropping) if (!await dropUnanswered!(join(reviews, name))) throw new Error(`The reviews changed while this one weighed the budget. ${weighAgain}`);
    const taken = new Set([...await reviewNames(reviews), ...(await entries(droppedDirectory(reviews))).filter((entry) => droppedEntry.test(entry)).map(droppedName)]);
    let read = 1;
    while (taken.has(finalReadPrefix + read)) read++;
    const name = finalReadPrefix + read;
    await reserveDecided(reviews, name, { ...identity, round: "final", read, scope: "final", base, from, phase, arbiter: verdict, capturedBy }, decision, stamping);
    return { round: "final", id: name, directory: join(reviews, name) };
  });
}

const coversReview = (base: string, reviewed: string, cleanBaseMerge: CleanBaseMerge) => reviewedThroughMerges(base, new Set([reviewed]), cleanBaseMerge) !== undefined;

export async function startReview(home: string, identity: ProofIdentity, request: ReviewRequest): Promise<Reserved> {
  const { scope, base, phase, decision, cleanBaseMerge = () => undefined, quietCommit = () => undefined, capturedBy = "author", lock, lockBudget, now } = request;
  const from = request.from ?? base;
  const permit = { arbiter: request.arbiter, limits: request.limits, autonomy: request.autonomy };
  if (!["full", "fixes", "final"].includes(scope)) throw new Error("Review scope must be full, fixes, or final");
  if (phase !== undefined && scope !== "final") throw new Error("--phase applies only to final reads");
  if (base !== undefined && !sha.test(base)) throw new Error("Review base needs a full commit SHA");
  if (base !== undefined && scope === "full") throw new Error("--scope full reads the diff from the merge base. Drop --base");
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  await mkdir(reviews, { recursive: true, mode: 0o700 });
  if (scope === "final") return startFinalRead(home, identity, base, decision, finalReadPhase(phase ?? "review"), permit, cleanBaseMerge, quietCommit, capturedBy, from, { lock, lockBudget, now, dropUnanswered: request.dropUnanswered });
  return startRound(home, identity, reviews, { scope, base, from, forkBase: request.forkBase, decision, permit, cleanBaseMerge, capturedBy, opening: request.opening ?? (async () => false), sanity: request.sanity ?? (async () => {}), reserving: { lock, lockBudget, now } });
}

type RoundStart = { scope: string; base?: string; from?: string; forkBase?: string; decision: Decision | undefined; permit: Permit; cleanBaseMerge: CleanBaseMerge; capturedBy: CapturedBy; opening: () => Promise<boolean>; sanity: () => Promise<void>; reserving: Reserving };

async function startRound(home: string, identity: ProofIdentity, reviews: string, { scope, base, from, forkBase, decision, permit, cleanBaseMerge, capturedBy, opening, sanity, reserving: { lockBudget, ...stamping } }: RoundStart): Promise<Reserved> {
  const { free, ceiling } = permit.limits;
  const snapshot = async () => ({ ...await reviewsSpent(reviews, "review", "unfinished spends"), round: await nextRound(reviews) });
  const permitRound = async ({ round, spent }: Awaited<ReturnType<typeof snapshot>>) => {
    if (round === 1 && scope !== "full") throw new Error("Round 1 is --scope full: it reviews the whole PR diff. Drop --base");
    if (round > 1) await requireFinished(reviews, round);
    const opened = round > 1 && scope === "full" && await opening();
    if (round > 1 && decision?.mark !== "👤" && !opened) await requireBoughtRound(home, identity);
    if (round > 1 && !opened) await checkLaterRound(reviews, round, scope, base, decision, cleanBaseMerge);
    if (round > 1) await sanity();
    return permitReview(home, identity, spent >= free, spent >= ceiling ? budgetSpent(permit.limits) : undefined, decision, permit);
  };
  return reserveWeighed(reviews, lockBudget, snapshot, permitRound, async ({ round }, verdict) => {
    await reserveDecided(reviews, String(round), { ...identity, round, scope, base, from, ...forkBase ? { forkBase } : {}, arbiter: verdict, capturedBy }, decision, stamping);
    return { round, id: String(round), directory: join(reviews, String(round)) };
  });
}

async function nextRound(reviews: string) {
  for (let round = 1; round <= 100; round++) {
    try { await access(join(reviews, String(round))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return round;
    }
  }
  throw new Error("Review limit exceeded");
}

type Claim = { repository: string; pr: number };
const claimPath = (home: string, answer: HeardAnswer) => join(ledgerRoot(home), "claims", `${createHash("sha256").update(`${answer.thread}/${answer.message}`).digest("hex")}.json`);

async function requireFinished(reviews: string, round: number) {
  try { await access(join(reviews, String(round - 1), "findings.md")); }
  catch { throw new Error("Previous review round is unfinished. Reuse its reservation before starting another panel."); }
}

async function checkLaterRound(reviews: string, round: number, scope: string, base: string | undefined, decision: DecisionMark | undefined, cleanBaseMerge: CleanBaseMerge) {
  if (scope === "full" && decision) return;
  const previous = JSON.parse(await readFile(join(reviews, String(round - 1), "round.json"), "utf8")) as ProofIdentity;
  if (scope !== "fixes" || !base) throw new Error(`Round ${round} needs --scope fixes --base ${previous.commit}, the commit of round ${round - 1}. With --agent '<your reason>', or the user's --override, --scope full reviews the whole PR diff again`);
  if (!coversReview(base, previous.commit, cleanBaseMerge)) throw new Error(`Round ${round} needs --base ${previous.commit}, the commit of round ${round - 1}`);
}

async function requireBoughtRound(home: string, identity: ProofIdentity) {
  const last = (await finishedReviews(home, identity)).at(-1);
  if (!last) return;
  const directory = join(pullRequestDirectory(home, identity), "reviews", last.name);
  const findings = await readFile(join(directory, "findings.md"), "utf8");
  const responses = await readFile(join(directory, "responses.md"), "utf8").catch(() => "");
  if (answeredFindings(findings, responses).findings.some(buysRound)) return;
  const label = reviewLabel(last.name);
  const stop = `${label[0]!.toUpperCase()}${label.slice(1)} found no bug in production code that the PR introduced, so the review loop stops.`;
  throw new Error(`${stop} Reject a finding the base has too with its base lines, and list it under Known issues. When fixes since ${label} changed production code, give them a final read with --scope final. Do not ask the user for another round. Only the user's --override runs one: when the user asks for it, confirm it with your question tool. Question: "${roundQuestion} ${identity.repository}#${identity.pr}: ${stop}" Options: "${runOption}", "${stopOption}". When they choose "${runOption}", run this command again with --override '<date> "${runOption}"'`);
}

type AnsweredFinding = ReturnType<typeof answeredFindings>["findings"][number];

function unbold(text: string) {
  let [start, end] = [0, text.length];
  while (text[start] === "*") start++;
  while (end > start && text[end - 1] === "*") end--;
  return text.slice(start, end).trim();
}

function locationOf(field: string) {
  const bare = unbold(field.trim());
  const plain = (bare.startsWith("[") && bare.endsWith(")") ? /^\[([^\]]*)\]\(/.exec(bare)?.[1] ?? bare : bare).replace(/[`*]/g, "").trim();
  const colon = plain.lastIndexOf(":");
  return colon > 0 && /^\d+(?:-\d+)?$/.test(plain.slice(colon + 1)) ? plain.slice(0, colon).trim() : undefined;
}
const tailField = /^(?:anchor|sites):/i;

function buysRound({ text, note, test, answer }: AnsweredFinding) {
  if (note || test || answer?.verdict === "rejected" || answer?.verdict === "known") return false;
  const fields = fieldsOutsideCode(text);
  const severity = fields && statedSeverity(fields);
  if (!fields || (severity !== "blocker" && severity !== "major")) return false;
  const tail = fields.findIndex((field) => tailField.test(field));
  if (fields.slice(0, tail < 0 ? undefined : tail).some((field) => /^[*_]*\[base\]/i.test(field))) return false;
  const site = fields.slice(0, 2).map(locationOf).find(Boolean);
  return site === undefined || isProductionFile(site);
}

function claimedOn(text: string) {
  try {
    const claim = JSON.parse(text) as Claim;
    return `${claim.repository}#${claim.pr}`;
  } catch { return "a PR"; }
}

const usedOn = (where: string) => `This answer is already used on ${where}. One answer counts once. Ask the user again`;

export async function usedAnswer(home: string, answer: HeardAnswer) {
  const claim = await readFile(claimPath(home, answer), "utf8").catch(() => undefined);
  if (claim !== undefined) return usedOn(claimedOn(claim));
  const recorded = (await recordedAnswers(home)).find((entry) => entry.message === messageOf(answer));
  return recorded && usedOn(recorded.where);
}

export const acceptGapOption = "Accept the gap";
export const keepGapOption = "Keep the gap open";
const gapLead = (identity: ProofIdentity, kind: string) => `Accept the ${kind} gap? ${identity.repository}#${identity.pr}:`;
export const gapQuestion = (identity: ProofIdentity, kind: string, reason: string) => `${gapLead(identity, kind)} ${reason}`;

export const recordGapCommand = (identity: ProofIdentity, kind: string) => `hedge decision record --mark 👤 --class proof-gap --kind ${kind} --pr ${identity.repository}#${identity.pr}`;

export function askGap(identity: ProofIdentity, kind: string, reason: string, autonomy: Autonomy) {
  if (autonomy === "end") return `Decide the gap yourself: run hedge decision record --mark 🤖 --class proof-gap --kind ${kind} --pr ${identity.repository}#${identity.pr} --question ${shellQuoted(gapQuestion(identity, kind, reason))} --answer ${shellQuoted(acceptGapOption)} --rejected ${shellQuoted(keepGapOption)} --reason '<your reason>'. Keep the gap open while the proof can still run. It lands in the ledger as a 🤖 proof-gap decision, and ${endTableNote}.`;
  return `Ask the user with your question tool. Question: "${gapQuestion(identity, kind, reason)}" Options: "${acceptGapOption}", "${keepGapOption}". When they choose "${acceptGapOption}", run ${recordGapCommand(identity, kind)}`;
}

export function requireChoice(answer: HeardAnswer, lead: string, [accept, decline]: [string, string], refused: string) {
  if (answer.source !== "question") throw new Error(`"${answer.words}" is a message the user typed. Only their answer to your question tool counts: ask "${lead} …" with the options "${accept}" and "${decline}"`);
  if (!normalized(answer.answered).startsWith(normalized(lead))) throw new Error(`"${answer.words}" answers another question ("${answer.answered}"). Ask the question that hedge proof printed, which starts "${lead}"`);
  if (![accept, `${accept} (Recommended)`].map(normalized).includes(normalized(answer.words))) throw new Error(`The user chose "${answer.words}", not "${accept}". ${refused}`);
}

type RoundDecision = { decision?: Decision; recorded?: undefined } | { decision: DecisionMark; recorded: true };
export type Reservation = ProofIdentity & { round: number | "final"; scope: string; base?: string; from?: string; forkBase?: string; capturedBy?: CapturedBy; reviewer?: string; lastFailure?: string } & RoundDecision;

export const readReservation = (directory: string) => readJson<Reservation | undefined>(join(directory, "round.json"), undefined);

export async function requireReservation(directory: string) {
  const reservation = await readReservation(directory);
  if (!reservation) throw new Error(`Review round ${basename(directory)} is not reserved. Reserve it with review-start first`);
  return reservation;
}

export async function markRecorded(directory: string) {
  const reservation = await readReservation(directory);
  if (!reservation?.decision || reservation.recorded) return;
  const { mark, id } = reservation.decision;
  await writeJson(join(directory, "round.json"), { ...reservation, decision: { mark, id }, recorded: true } satisfies Reservation);
}

const hasFindings = (directory: string) => access(join(directory, "findings.md")).then(() => true, () => false);

export async function unrecordedElsewhere(directory: string, commit: string) {
  const reservation = await readReservation(directory);
  if (!reservation?.decision || reservation.recorded || reservation.commit === commit || await hasFindings(directory)) return undefined;
  return reservation.decision;
}

export async function recordFailure(directory: string, cause: string) {
  await writeJson(join(directory, "round.json"), { ...await requireReservation(directory), lastFailure: redactSecrets(cause) } satisfies Reservation);
}

const droppedDirectory = (reviews: string) => join(reviews, "dropped");
const droppedName = (entry: string) => /^final-\d+/.exec(entry)?.[0] ?? entry;
const droppedEntry = /^final-\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type DroppedRead = { head: string; droppedAt: string; cause?: string };

export async function unansweredFinalRead(directory: string, head: ProofIdentity) {
  const reservation = await readReservation(directory);
  if (reservation?.round !== "final" || reservation.capturedBy !== "hedge" || reservation.commit === head.commit || await hasFindings(directory)) return undefined;
  if (await panelOutcome(directory) === "none") return { cause: reservation.lastFailure };
  const cause = await unansweredPanelCause(directory);
  return cause === undefined ? undefined : { cause };
}

export async function dropFinalRead(directory: string, head: ProofIdentity, now: Date) {
  const unanswered = await unansweredFinalRead(directory, head);
  if (!unanswered) return false;
  const { reservationId } = await readJson<ReservedAs>(join(directory, "round.json"), {});
  const dropped = join(droppedDirectory(dirname(directory)), `${basename(directory)}-${reservationId ?? crypto.randomUUID()}`);
  await mkdir(dirname(dropped), { recursive: true, mode: 0o700 });
  await writeJson(join(directory, "dropped.json"), { head: head.commit, droppedAt: now.toISOString(), ...unanswered.cause ? { cause: redactSecrets(unanswered.cause) } : {} } satisfies DroppedRead);
  await rename(directory, dropped);
  await rm(join(dropped, "round.lock"), { force: true });
  return true;
}

const causeCap = 300;

export async function droppedFinalReads(home: string, identity: ProofIdentity) {
  const dropped = droppedDirectory(join(pullRequestDirectory(home, identity), "reviews"));
  const reads = await Promise.all((await entries(dropped)).filter((entry) => droppedEntry.test(entry)).map(async (entry) => {
    const reservation = await readReservation(join(dropped, entry));
    const drop = await readJson<DroppedRead | undefined>(join(dropped, entry, "dropped.json"), undefined);
    const line = `${reviewLabel(droppedName(entry))} on ${short(reservation?.commit ?? "unknown")} dropped at ${short(drop?.head ?? "unknown")}: no reviewer answer was captured`;
    return { line, droppedAt: drop?.droppedAt ?? "", ...drop?.cause ? { cause: redactSecrets(drop.cause.replace(/\s+/g, " ").trim()).slice(0, causeCap) } : {} };
  }));
  return reads.sort((a, b) => a.droppedAt.localeCompare(b.droppedAt) || a.line.localeCompare(b.line));
}

export async function roundDirectories(home: string, identity: ProofIdentity) {
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  return (await reviewNames(reviews)).map((name) => join(reviews, name));
}

export type RoundId = number | `final-${number}`;

export function roundId(value: string): RoundId {
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  if (/^final-[1-9]\d*$/.test(value)) return value as RoundId;
  throw new Error(`--round takes a round number, or the id of a final read that review-start printed, such as final-2${value === "final" ? ". Pass final-<n>" : ""}`);
}

export async function unfinishedReview(home: string, identity: ProofIdentity, capturedBy: CapturedBy) {
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  for (const name of await reviewNames(reviews)) {
    const directory = join(reviews, name);
    const reservation = await readReservation(directory);
    const finished = await hasFindings(directory);
    if (reservation?.capturedBy !== capturedBy || reservation.commit !== identity.commit || finished) continue;
    if (capturedBy === "hedge" && reservation.scope !== "full" && !reservation.base) { await rm(directory, { recursive: true, force: true }); continue; }
    return { reservation, directory };
  }
  return undefined;
}

async function latestFinalRead(reviews: string) {
  const reads = (await reviewNames(reviews)).filter((name) => name.startsWith(finalReadPrefix)).map((name) => Number(name.slice(finalReadPrefix.length)));
  if (!reads.length) throw new Error("No final read is reserved");
  return finalReadPrefix + Math.max(...reads);
}

const sameContent = async (path: string, bytes: Buffer) => (await readFile(path).catch(() => undefined))?.equals(bytes) ?? false;

async function roundDirectory(home: string, identity: ProofIdentity, round: RoundId | "final") {
  if (typeof round === "number" && (!Number.isSafeInteger(round) || round < 1)) throw new Error("Invalid review round");
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  return join(reviews, round === "final" ? await latestFinalRead(reviews) : String(round));
}

export async function reviewDirectory(home: string, identity: ProofIdentity, round?: RoundId | "final") {
  if (round !== undefined) return roundDirectory(home, identity, round);
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  const names = await reviewNames(reviews);
  if (!names.length) throw new Error("No review round is reserved");
  if (names.some((name) => name.startsWith(finalReadPrefix))) return join(reviews, await latestFinalRead(reviews));
  return join(reviews, String(Math.max(...names.map(Number))));
}

export async function finishReview(home: string, identity: ProofIdentity, round: RoundId, findings: string, reviewer: string) {
  // The judge reads the name outside its <untrusted> wrapper, so it stays to name characters.
  if (!/^[\w.:@/+[\] -]+$/.test(reviewer) || !reviewer.trim()) throw new Error("--reviewer needs the model that wrote the findings, such as gpt-6.2-sol, in letters, digits and . : @ / + [ ] -");
  const bytes = await readFile(findings);
  if (!bytes.toString().trim()) throw new Error(`${findings} is empty. Save the reviewer's findings, or "No findings." when it found none`);
  const directory = await roundDirectory(home, identity, round);
  if (await panelOutcome(directory) !== "none") throw new Error(`Round ${round} is a panel round, and Hedge saves its findings once every lens is done. Rerun its failed lenses with hedge proof review, or wait for the running ones with hedge proof review --wait. For a PR that the user's rules exempt from the swarm, record hedge proof gap --kind panel --reason <the exception> instead`);
  await storeFindings(directory, identity, round, bytes, reviewer.trim(), "author");
  return directory;
}

export async function storeCapturedFindings(directory: string, identity: ProofIdentity, round: RoundId, answer: string, reviewer: string, usage?: Usage) {
  await storeFindings(directory, identity, round, Buffer.from(answer.trim() + "\n"), reviewer, "hedge", usage);
}

async function storeFindings(directory: string, identity: ProofIdentity, round: RoundId, bytes: Buffer, reviewer: string, capturedBy: CapturedBy, usage?: Usage) {
  const reservation = await readJson<Reservation | undefined>(join(directory, "round.json"), undefined);
  if (!reservation) throw new Error(`Review round ${round} is not reserved. Reserve it with review-start first`);
  if (reservation.commit !== identity.commit) throw new Error(`Round ${round} reviews ${reservation.commit}. Pass --commit ${short(reservation.commit)}, or reserve a round for this commit`);
  const destination = join(directory, "findings.md");
  if (!(await sameContent(destination, bytes))) {
    const temporary = join(directory, ".findings-" + crypto.randomUUID());
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await sameContent(destination, bytes))) throw new Error(`Round ${round} already has other findings in ${destination}`);
    } finally { await rm(temporary, { force: true }); }
  }
  await writeJson(join(directory, "round.json"), { ...await readReservation(directory) ?? reservation, reviewer, capturedBy, ...usage ? { usage } : {} });
}

export async function respondToReview(home: string, identity: ProofIdentity, round: RoundId, responses: string, ceiling: number) {
  const bytes = await readFile(responses);
  if (!bytes.toString().trim()) throw new Error(`${responses} is empty. Answer each finding: fixed in which commit, or rejected and why`);
  const directory = await roundDirectory(home, identity, round);
  const findings = await savedFindings(directory);
  if (findings === undefined) throw new Error(`Review round ${round} has no findings yet`);
  const missing = unanswered(findings, bytes.toString());
  if (missing.length) throw new Error(`Answer findings ${missing.join(", ")} too: one line each, numbered in the order of findings.md, such as "${missing[0]}. fixed in 1a2b3c4: <how>", "${missing[0]}. rejected: <why>", or, at the review budget, "${missing[0]}. known: <why>" for a finding listed under Known issues. Minor and nit findings need no answer; a TESTS item gets a test-only rewrite or delete`);
  if (answeredFindings(findings, bytes.toString()).findings.some(({ answer }) => answer?.verdict === "known")) {
    const reviews = join(pullRequestDirectory(home, identity), "reviews");
    const phase = (await readJson<{ phase?: FinalReadPhase }>(join(directory, "round.json"), {})).phase ?? "review";
    const { spent } = await reviewsSpent(reviews, phase, "finished only");
    if (spent < ceiling) throw new Error(`Answer a finding "known" only once the review budget of ${ceiling} reviews is spent; ${spent} ran. Fix or reject it now`);
  }
  const destination = join(directory, "responses.md");
  const temporary = `${destination}.${crypto.randomUUID()}`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
  return destination;
}

const findingItem = /^\s*(?:[-*]|\d+[.)])\s+\S/;
const answerItem = /^\s*(?:[-*]\s+)?(\d+)[.):]\s+\**(fixed|rejected|known)\b/i;

const noFinding = /^(?:#.*|no findings\.?|findings:?|\(none\))$/i;

const findingsBlock = /^\s*FINDINGS\b:?/;
const testsBlock = /^\s*(?:#+\s*)?\**TESTS\b/;
const listItem = /^\s*(?:[-*]|\d+[.)])\s+(.*)/;
const severityField = /^\**(blocker|major|minor|nit)\**$/i;
const severityShorthand = /^\**(?:minor|nit)(?:[,:]\**|\**[,:])\s/i;

function closingRun(line: string, size: number, from: number) {
  let at = from;
  for (;;) {
    at = line.indexOf("`".repeat(size), at);
    if (at < 0 || (line[at - 1] !== "`" && line[at + size] !== "`")) return at;
    while (line[at] === "`") at++;
  }
}

function splitOutsideCode(line: string) {
  const fields: string[] = [];
  let start = 0, at = 0;
  while (at < line.length) {
    if (line[at] === "\\") { at += 2; continue; }
    if (line[at] === "|") { fields.push(line.slice(start, at)); start = ++at; continue; }
    if (line[at] !== "`") { at++; continue; }
    let end = at;
    while (line[end] === "`") end++;
    const close = closingRun(line, end - at, end);
    at = close < 0 ? end : close + end - at;
  }
  return [...fields, line.slice(start)].map((field) => field.trim());
}

const fieldsOutsideCode = (text: string) => {
  const item = listItem.exec(text.split("\n").map((line) => line.trim()).join(" "))?.[1];
  return item === undefined ? undefined : splitOutsideCode(item);
};

const itemFields = (text: string) => listItem.exec(text.split("\n")[0]!)?.[1]?.split("|").map((field) => field.trim());

const statedSeverity = (fields: string[]) => fields.slice(0, Math.min(2, fields.length - 1)).map((field) => severityField.exec(field)?.[1]?.toLowerCase()).find(Boolean);

function flooredItem(text: string) {
  const fields = itemFields(text);
  if (fields === undefined) return false;
  const stated = statedSeverity(fields);
  return stated ? stated === "minor" || stated === "nit" : severityShorthand.test(fields.join("|"));
}

const anchorIntro = /^(?:fleet|hedge) compared each finding's anchor with the diff and with earlier reviews of this PR\.$/;
const anchorNote = /^- (?:Not in the diff, so check it before triage: \S|Seen before in [^:\n]+: \S|\d+ findings? quotes? no anchor\.$)/;

type ReviewedLine = { text: string; note: boolean };

function anchorCheckLines(lines: string[]) {
  const notes = new Set<number>();
  lines.forEach((line, index) => {
    if (line.trim() !== anchorHeading) return;
    let next = index + 1;
    while (next < lines.length && !lines[next]!.trim()) next++;
    if (!anchorIntro.test(lines[next]?.trim() ?? "")) return;
    notes.add(index).add(next);
    for (next++; next < lines.length && (!lines[next]!.trim() || anchorNote.test(lines[next]!)); next++) notes.add(next);
  });
  return notes;
}

function reviewedLines(findings: string) {
  const lines = findings.replace(/\r\n?/g, "\n").split("\n");
  const notes = anchorCheckLines(lines);
  const lensAnswer = lines.some((line) => findingsBlock.test(line));
  let inside = !lensAnswer;
  let tests = false;
  const kept: ReviewedLine[] = [];
  const tested: ReviewedLine[] = [];
  lines.forEach((line, index) => {
    const note = notes.has(index);
    if (testsBlock.test(line)) { tests = true; inside = false; return; }
    if (findingsBlock.test(line)) { tests = false; inside = true; kept.push({ text: line.replace(findingsBlock, ""), note }); return; }
    if (/^COVERED\b/.test(line)) { tests = false; inside = false; }
    else if (/^#/.test(line)) { tests = false; if (!lensAnswer) inside = true; }
    if (tests) tested.push({ text: line, note });
    else if (inside) kept.push({ text: line, note });
  });
  return { kept, tested };
}

function ladderFindings(findings: string) {
  let tests = false;
  return findings.split("\n").filter((line) => {
    if (testsBlock.test(line)) tests = true;
    else if (findingsBlock.test(line) || /^(COVERED\b|#)/.test(line)) tests = false;
    return !tests && !flooredItem(line);
  }).join("\n");
}

const continued = /^\s+\S/;
const lazyContinued = /^[^\s#]/;

/** The findings, then the TESTS items. Each part on its own: prose without list items is one finding of its part, and prose beside only Anchor check notes is one finding after all items, so no earlier number moves. */
export function reviewedFindings(findings: string) {
  return reviewedItems(findings).map(({ text }) => text);
}

function reviewedItems(findings: string) {
  const { kept, tested } = reviewedLines(findings);
  const parts = [listedItems(kept), testItems(listedItems(tested))];
  return [...parts.flatMap(({ items }) => items), ...parts.flatMap(({ recovered }) => recovered)];
}

function testItems({ items, recovered }: { items: ReviewedItem[]; recovered: ReviewedItem[] }) {
  const mark = (item: ReviewedItem) => ({ ...item, test: true });
  return { items: items.map(mark), recovered: recovered.map(mark) };
}

type ReviewedItem = ReviewedLine & { test?: boolean };

function listedItems(reviewed: ReviewedLine[]): { items: ReviewedItem[]; recovered: ReviewedItem[] } {
  const items: ReviewedLine[] = [];
  let open = false;
  for (const { text: line, note } of reviewed) {
    const joins: boolean = items.length > 0 && (continued.test(line) || (open && lazyContinued.test(line)));
    if (findingItem.test(line)) items.push({ text: line.trim(), note });
    else if (joins) items[items.length - 1]!.text += `\n${line.trim()}`;
    open = Boolean(line.trim()) && (findingItem.test(line) || joins);
  }
  const text = reviewed.flatMap(({ text: line, note }) => note || !line.trim() ? [] : [line.trim()]);
  if (items.some(({ note }) => !note) || text.every((line) => noFinding.test(line))) return { items, recovered: [] };
  const prose = { text: text.join("\n"), note: false };
  return items.length ? { items, recovered: [prose] } : { items: [prose], recovered: [] };
}

export type Answer = { verdict: "fixed" | "rejected" | "known"; text: string };

export function answeredFindings(findings: string, responses: string) {
  const items = reviewedItems(findings);
  const answers = new Map<number, Answer>();
  const other: string[] = [];
  let last: Answer | undefined;
  for (const line of responses.split("\n")) {
    const match = answerItem.exec(line);
    const number = Number(match?.[1]);
    if (match && number >= 1 && number <= items.length && !answers.has(number)) answers.set(number, last = { verdict: match[2]!.toLowerCase() as Answer["verdict"], text: line.trim() });
    else if (!match && last && continued.test(line)) last.text += `\n${line.trim()}`;
    else if (line.trim()) { last = undefined; other.push(line.trim()); }
  }
  return { findings: items.map(({ text, note, test }, index) => ({ text, ...note ? { note } : {}, ...test ? { test } : {}, ...answers.has(index + 1) ? { answer: answers.get(index + 1)! } : {} })), other: other.join("\n") };
}

const majorItem = /^\s*(?:[-*]|\d+[.)])\s+(?:[^|\n]*\|)?\s*\**major\**\s*\|/i;

const knownBlockers = (findings: string, responses: string) =>
  answeredFindings(findings, responses).findings.flatMap((finding, index) => finding.answer?.verdict === "known" && !majorItem.test(finding.text) && !needsNoAnswer(finding) ? [index + 1] : []);

const locations = (text: string) => [...text.matchAll(/(?<![\w./-])([\w./-]+:\d+)(?![\w:])/g)].map((match) => match[1]!);

const unlistedKnown = (findings: string, responses: string, listed: string[]) =>
  answeredFindings(findings, responses).findings.flatMap(({ text, answer }, index) => {
    const location = locations(text)[0];
    return answer?.verdict === "known" && !(location && listed.some((item) => locations(item).includes(location))) ? [index + 1] : [];
  });

const needsNoAnswer = ({ text, note, test }: { text: string; note?: boolean; test?: boolean }) => note || (!test && flooredItem(text));

const unanswered = (findings: string, responses: string) =>
  answeredFindings(findings, responses).findings.flatMap((finding, index) => finding.answer || needsNoAnswer(finding) ? [] : [index + 1]);

export const proofKinds = ["live-run", "ui-walk", "prod-shape", "cross-version", "shadow-diff", "post-deploy-watch", "dev-observed"] as const;
export type ProofKind = (typeof proofKinds)[number];
const gapKinds = [...proofKinds, "ci", "judge", "panel"] as const;
export type GapKind = (typeof gapKinds)[number];

export function proofKind(value: string): ProofKind {
  if (!(proofKinds as readonly string[]).includes(value)) throw new Error(`Unknown proof kind ${value}. Use one of ${proofKinds.join(", ")}`);
  return value as ProofKind;
}

export function gapKind(value: string): GapKind {
  if (!(gapKinds as readonly string[]).includes(value)) throw new Error(`Unknown gap kind ${value}. Use one of ${gapKinds.join(", ")}`);
  return value as GapKind;
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

export async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

/** The dev PR whose observed result a prod PR waits on, when infrastructure goes to dev first. */
export type DevPr = { repository: string; pr: number };
export type Owed = { kinds: ProofKind[]; none?: { reason: string; recordedAt: string }; author?: Family; afterDev?: DevPr };

export function devPr(value: string): DevPr {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value.trim());
  if (!match) throw new Error(`--after-dev takes the dev PR as <owner/name>#<number>, not ${value}`);
  return { repository: match[1]!, pr: Number(match[2]) };
}

export const devText = (dev: DevPr) => `${dev.repository}#${dev.pr}`;
const requiredPath = (home: string, identity: ProofIdentity) => join(pullRequestDirectory(home, identity), "required.json");

export async function readOwed(home: string, identity: ProofIdentity): Promise<Owed | undefined> {
  const owed = await readJson<ProofKind[] | Owed | undefined>(requiredPath(home, identity), undefined);
  return Array.isArray(owed) ? { kinds: owed } : owed;
}

function settleAuthor(recorded: Owed | undefined, author: Family | undefined): Family {
  if (recorded?.author && author && recorded.author !== author) throw new Error(`The PR is recorded as written by ${recorded.author}. The author family does not change`);
  const settled = recorded?.author ?? author;
  if (!settled) throw new Error("Pass --author claude|gpt: no Claude Code or Codex session variable says which family wrote the PR");
  return settled;
}

/** afterDev names the dev PR whose observed result the PR waits on, and adds dev-observed. It is recorded once. */
export async function requireProofs(home: string, identity: ProofIdentity, kinds: string[], author?: Family, afterDev?: DevPr) {
  const recorded = await readOwed(home, identity);
  if (afterDev && recorded?.afterDev && devText(afterDev).toLowerCase() !== devText(recorded.afterDev).toLowerCase()) throw new Error(`The PR already waits on dev PR ${devText(recorded.afterDev)}. The dev PR does not change`);
  const dev = recorded?.afterDev ?? afterDev;
  const owed = new Set(recorded?.kinds ?? []);
  for (const kind of kinds) owed.add(proofKind(kind));
  if (dev) owed.add("dev-observed");
  if (owed.has("dev-observed") && !dev) throw new Error("dev-observed needs --after-dev <owner/name>#<number>: the dev PR whose observed result this PR waits on");
  const sorted = proofKinds.filter((kind) => owed.has(kind));
  await writeJson(requiredPath(home, identity), { kinds: sorted, author: settleAuthor(recorded, author), ...dev ? { afterDev: dev } : {} } satisfies Owed);
  return sorted;
}

export async function requireNone(home: string, identity: ProofIdentity, reason: string, author?: Family) {
  if (!reason.trim()) throw new Error("--none needs --reason with why the PR owes no proof");
  const recorded = await readOwed(home, identity);
  if (recorded?.kinds.length) throw new Error(`The PR already owes ${recorded.kinds.join(", ")}. A recorded kind stays owed`);
  const owed: Owed = { kinds: [], none: { reason, recordedAt: new Date().toISOString() }, author: settleAuthor(recorded, author) };
  await writeJson(requiredPath(home, identity), owed);
  return owed;
}

export async function authorOf(home: string, identity: ProofIdentity) {
  const author = (await readOwed(home, identity))?.author;
  if (!author) throw new Error("The PR has no recorded author family. Run hedge proof require with --author claude|gpt, or from the author's session");
  return author;
}

type Gap = { commit: string; reason: string; recordedAt: string; acceptance?: { instruction: string; acceptedAt: string; answer?: HeardAnswer } };

const gapPath = (home: string, identity: ProofIdentity, kind: GapKind) => join(pullRequestDirectory(home, identity), "gaps", `${kind}.json`);

export async function recordGap(home: string, identity: ProofIdentity, kind: string, reason: string, now = new Date()) {
  const path = gapPath(home, identity, gapKind(kind));
  if (!reason.trim()) throw new Error("A gap needs the reason the proof could not run");
  const earlier = await readJson<Gap | undefined>(path, undefined);
  const sameCommit = earlier?.commit === identity.commit;
  const kept = earlier?.acceptance && (kind !== "judge" || sameCommit) ? { acceptance: earlier.acceptance } : {};
  const gap: Gap = { commit: identity.commit, reason, recordedAt: kind === "judge" && sameCommit ? earlier.recordedAt : now.toISOString(), ...kept };
  await writeJson(path, gap);
  return gap;
}

async function agentInstructions(home: string) {
  const guides = join(home, ".agents/guides");
  const files = [join(home, ".agents/AGENTS.md"), ...(await entries(guides)).filter((name) => name.endsWith(".md")).sort().map((name) => join(guides, name))];
  return (await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => "")))).join("\n");
}
const minimumRule = 30;

function instructionSentences(instructions: string) {
  return instructions.split(/[.!?\n]+/).map((sentence) => normalized(sentence).replace(/^[^a-z0-9]+/, "")).filter((sentence) => sentence.length >= minimumRule);
}

type RecordedAnswer = { where: string; message?: string };
const messageOf = (answer: HeardAnswer | undefined) => answer && `${answer.thread}/${answer.message}`;

async function recordedAnswers(home: string) {
  const answers: RecordedAnswer[] = [];
  const root = ledgerRoot(home);
  for (const owner of await entries(root)) for (const name of await entries(join(root, owner))) for (const pr of await entries(join(root, owner, name))) {
    const [directory, repository] = [join(root, owner, name, pr), `${owner}/${name}`];
    for (const review of await reviewNames(join(directory, "reviews"))) {
      const round = await readJson<{ override?: string; answer?: HeardAnswer } | undefined>(join(directory, "reviews", review, "round.json"), undefined);
      if (round?.override) answers.push({ where: `${repository}#${pr} ${reviewLabel(review)}`, message: messageOf(round.answer) });
    }
    for (const file of (await entries(join(directory, "gaps"))).filter((entry) => entry.endsWith(".json"))) {
      const acceptance = (await readJson<Gap | undefined>(join(directory, "gaps", file), undefined))?.acceptance;
      if (acceptance) answers.push({ where: `${repository}#${pr} ${file.slice(0, -5)} gap`, message: messageOf(acceptance.answer) });
    }
  }
  return answers;
}

export async function refuseInstructionQuote(home: string, text: string) {
  const answer = normalized(text);
  if (instructionSentences(await agentInstructions(home)).some((sentence) => answer.includes(sentence))) {
    throw new Error("This quotes the user's instructions in ~/.agents, not their answer to this question. A standing rule there is recorded once with hedge proof standing; otherwise ask the user and record their reply");
  }
}

export const retiredStandingKinds = ["review", "judge", "post-deploy-watch"];
const standingKinds = gapKinds.filter((kind) => !retiredStandingKinds.includes(kind));
export type StandingKind = GapKind;
/** repositories, when set, are the only repositories whose PRs the rule covers, as owner/name. */
type Standing = { kind: StandingKind; until: string; rule: string; recordedAt: string; repositories?: string[] };
const standingPath = (home: string) => join(ledgerRoot(home), "standing.json");

function standingKind(value: string): StandingKind {
  if (retiredStandingKinds.includes(value)) throw new Error(`A standing rule no longer takes ${value}. Decide a review round with --agent '<your reason>', and a ${retiredStandingKinds.slice(1).join(" or ")} gap with hedge decision record --mark 🤖: both land in the decision ledger`);
  if (!(standingKinds as readonly string[]).includes(value)) throw new Error(`Unknown standing kind ${value}. Use one of ${standingKinds.join(", ")}`);
  return value as StandingKind;
}

/** GitHub names a repository without regard to case: a scope compares owner/name in lower case. */
const scopeKey = (repositories: string[] | undefined) => repositories?.map((repository) => repository.toLowerCase()).sort().join(",") ?? "";

/**
 * A standing rule is recorded with the command the user's instructions give for it. repositories, from --repositories,
 * limits it to the PRs of those repositories; the scope is part of the command their instructions must hold.
 */
export async function recordStanding(home: string, kinds: string, until: string, rule: string, repositories?: string) {
  const covered = kinds.split(",").map((kind) => standingKind(kind.trim()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until))) throw new Error("--until needs a date such as 2026-11-02");
  const scope = repositories === undefined ? undefined : repositories.split(",");
  if (scope && !scope.every((repository) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))) throw new Error("--repositories needs owner/name repositories separated by commas, such as owner/name");
  const command = `hedge proof standing --kind ${kinds} --until ${until} ${repositories ? `--repositories ${repositories} ` : ""}--rule "${rule}"`;
  if (normalized(rule).length < minimumRule || !normalized(await agentInstructions(home)).includes(normalized(command))) {
    throw new Error(`The user's instructions in ~/.agents/AGENTS.md or ~/.agents/guides must hold this command word for word: ${command}. Only their own instructions set a standing rule, its kinds, its repositories, and its date`);
  }
  const recordedAt = new Date().toISOString();
  const recorded = covered.map((kind): Standing => ({ kind, until, rule, recordedAt, ...scope ? { repositories: scope } : {} }));
  const others = (await listStanding(home)).filter((record) => !covered.includes(record.kind) || scopeKey(record.repositories) !== scopeKey(scope));
  await writeJson(standingPath(home), [...others, ...recorded]);
  return recorded;
}

export const listStanding = (home: string) => readJson<Standing[]>(standingPath(home), []);

/**
 * The live standing rule of a kind for a PR of repository: a record whose kind, rule, and scope a current command in
 * the user's instructions still names, before both dates. A scoped rule covers only its repositories; a rule without
 * a scope covers every repository.
 */
export async function standingFor(home: string, kind: StandingKind, now: Date, repository: string) {
  if (!standingKinds.includes(kind)) return undefined;
  const today = now.toISOString().slice(0, 10);
  const commands = standingCommands(await agentInstructions(home));
  const live = (standing: Standing) => standing.kind === kind && today < standing.until
    && (!standing.repositories || standing.repositories.some((covered) => covered.toLowerCase() === repository.toLowerCase()))
    && commands.some((command) => command.kinds.includes(kind) && normalized(command.rule) === normalized(standing.rule) && scopeKey(command.repositories) === scopeKey(standing.repositories) && today < command.until);
  return (await listStanding(home)).find(live);
}

function standingCommands(instructions: string) {
  const commands = instructions.replace(/\s+/g, " ").matchAll(/hedge proof standing --kind ([a-z,-]+) --until (\d{4}-\d{2}-\d{2}) (?:--repositories (\S+) )?--rule ["“]([^"”]*)["”]/g);
  return [...commands].map(([, kinds, until, repositories, rule]) => ({ kinds: kinds!.split(","), until: until!, repositories: repositories?.split(","), rule: rule! }));
}

export async function judgeGap(home: string, identity: ProofIdentity, now: Date, decisions: Decisions, tier: Tier) {
  const gap = await readJson<Gap | undefined>(gapPath(home, identity, "judge"), undefined);
  if (gap?.commit !== identity.commit) return undefined;
  const weighed = await gapAcceptance({ home, identity, now, decisions, tier }, gap, "judge");
  return { reason: gap.reason, acceptance: weighed.acceptance, lapsed: weighed.lapsed, kept: weighed.kept, line: weighed.acceptance?.line ?? notAccepted(decisions, weighed), condition: weighed.condition };
}

export type JudgeGap = NonNullable<Awaited<ReturnType<typeof judgeGap>>>;

export function withBrokenConditions(gap: JudgeGap, broken: string[]): JudgeGap & { broken?: string[] } {
  if (!gap.acceptance || !broken.length) return gap;
  return { ...gap, acceptance: undefined, line: `not accepted (the judge finds the condition of decision ${broken.join(", ")} broken)`, broken };
}

export const judgeGapProof = (commit: string, gap: JudgeGap): GapProof => ({
  commit, reason: gap.reason, ...acceptedPart(gap.acceptance), ...!gap.acceptance && gap.lapsed ? { lapsed: gap.lapsed } : {}, text: gap.line,
});

export type Decisions = DecisionState[] | { unreachable: string };

export async function readDecisions(ledger: Ledger): Promise<Decisions> {
  try { return fold(await ledger.read()); }
  catch (error) { return { unreachable: (error as Error).message }; }
}

type Acceptance = { by: "the user" | "agent" | "standing rule"; line: string; id?: string; mark?: Mark };
export type Condition = { id: string; kind: string; condition: string };
type Weigh = { home: string; identity: ProofIdentity; now: Date; decisions: Decisions; tier: Tier; ci?: CiResult };
type Weighed = { acceptance?: Acceptance; lapsed?: { id: string; reason: string }; condition?: Condition; kept?: string };

async function gapAcceptance(weigh: Weigh, gap: Gap | undefined, kind: GapKind): Promise<Weighed> {
  const { home, identity, now, decisions, tier, ci } = weigh;
  if (gap?.acceptance) return { acceptance: { by: "the user", line: `accepted ("${gap.acceptance.instruction}")` } };
  const afterGap = (decision: DecisionState) => kind !== "judge" || !gap || decision.at >= gap.recordedAt;
  const ledger = (Array.isArray(decisions) ? decisions : []).filter(afterGap);
  const accepted = (decision: DecisionState, by: Acceptance["by"]): Weighed => ({
    acceptance: { by, line: `accepted by ${decision.mark} decision ${decision.id} (${decision.answer})`, id: decision.id, mark: decision.mark },
    ...decision.scope.condition ? { condition: { id: decision.id, kind, condition: decision.scope.condition } } : {},
  });
  const users = usersAcceptance(ledger, identity, kind);
  if (users) return accepted(users, "the user");
  const kept = keptOwed(ledger, identity, kind);
  const agent = agentsAcceptance(ledger, identity, kind);
  const refusal = agentRefusal(tier, "proof-gap", [kind]);
  const lapse = agent && (refusal === "panel" ? panelRefusal
    : kept ? `the user keeps it owed, decision ${kept.id}`
    : refusal ?? (kind === "ci" && ci?.state !== "none" ? `CI on HEAD is ${ci?.state ?? "unknown"}` : undefined));
  if (agent && !lapse) return accepted(agent, "agent");
  const lapsed = agent && lapse ? { id: agent.id, reason: lapse } : undefined;
  const standing = kept || !Array.isArray(decisions) ? undefined : await standingFor(home, kind, now, identity.repository);
  if (!standing) return { lapsed, ...kept ? { kept: kept.id } : {} };
  const scoped = standing.repositories ? { condition: { id: `standing rule ${kind} until ${standing.until}`, kind, condition: standing.rule } } : {};
  return { acceptance: { by: "standing rule", line: `accepted by standing rule until ${standing.until}${standing.repositories ? ` for ${standing.repositories.join(", ")}` : ""}` }, ...scoped };
}

const lapseOf = ({ lapsed }: Weighed) => lapsed && { lapsed: lapsed.id };
const countedGap = (weighed: Weighed) => ({ condition: weighed.condition, ...lapseOf(weighed) });

const notAccepted = (decisions: Decisions, { lapsed }: Weighed) => lapsed ? `not accepted (🤖 decision ${lapsed.id} lapsed: ${lapsed.reason})` : Array.isArray(decisions) ? "not accepted" : `not accepted: hub unreachable (${decisions.unreachable})`;

export type GapProof = { commit?: string; reason?: string; accepted?: { by: Acceptance["by"]; mark?: Mark; id?: string }; lapsed?: { id: string; reason: string }; text: string };

const acceptedPart = (acceptance: Acceptance | undefined) =>
  acceptance ? { accepted: { by: acceptance.by, ...acceptance.mark ? { mark: acceptance.mark } : {}, ...acceptance.id ? { id: acceptance.id } : {} } } : {};

function gapProof(gap: Gap | undefined, weighed: Weighed, decisions: Decisions): GapProof {
  const { acceptance, lapsed } = weighed;
  return {
    ...gap ? { commit: gap.commit, reason: gap.reason } : {},
    ...acceptedPart(acceptance),
    ...!acceptance && lapsed ? { lapsed } : {},
    text: acceptance?.line ?? notAccepted(decisions, weighed),
  };
}

const gapText = (gap: GapProof) => gap.commit ? `gap from ${short(gap.commit)}, ${gap.text}: ${gap.reason}` : `gap ${gap.text}; no gap reason recorded`;

const short = (commit: string) => commit.slice(0, 7);

export async function entries(directory: string) {
  try { return await readdir(directory); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
}

async function newestFile(directory: string) {
  const times = await Promise.all((await entries(directory)).map(async (name) => (await stat(join(directory, name), { bigint: true })).mtimeNs));
  return times.reduce<bigint | undefined>((newest, time) => newest === undefined || time > newest ? time : newest, undefined);
}

type Proved = { directory?: string; reuse?: Reuse; time: bigint };

async function provedCommits(home: string, identity: ProofIdentity, kind: ProofKind) {
  const pullRequest = pullRequestDirectory(home, identity);
  const proved = new Map<string, Proved>();
  for (const commit of (await entries(pullRequest)).filter((name) => sha.test(name))) {
    const directory = join(pullRequest, commit, kind);
    const time = await newestFile(directory);
    if (time !== undefined) proved.set(commit, { directory, time });
  }
  const reused = join(pullRequest, "reused", kind);
  for (const file of await entries(reused)) {
    const commit = file.replace(/\.json$/, "");
    if (!sha.test(commit) || proved.has(commit)) continue;
    proved.set(commit, { reuse: await readJson<Reuse>(join(reused, file), { from: "", reason: "", recordedAt: "" }), time: (await stat(join(reused, file), { bigint: true })).mtimeNs });
  }
  return proved;
}

type Status = { problem: "missing" | "gap" | undefined; line: string; covered?: string; evidence?: string; condition?: Condition; lapsed?: string };

export type KindProof = { kind: ProofKind; line: string } & (
  | { state: "pending" }
  | { state: "waiting"; dev: string; reason: string }
  | { state: "ran"; commit: string; directory: string }
  | { state: "reused"; from: string; reason: string; directory: string }
  | { state: "carried"; from: string; origin?: string; merges: number; directory: string }
  | { state: "gap"; accepted: boolean; gap: GapProof }
  | { state: "missing"; newest?: string });
type KindState = KindProof extends infer P ? P extends KindProof ? Omit<P, "kind" | "line"> : never : never;

function kindLine(kind: ProofKind, proof: KindState) {
  switch (proof.state) {
    case "pending": return `${kind}: pending until the PR lands`;
    case "waiting": return `${kind}: waiting on the dev result of ${proof.dev}: ${proof.reason}`;
    case "ran": return `${kind}: evidence at HEAD in ${proof.directory}`;
    case "reused": return `${kind}: evidence reused from ${short(proof.from)}: ${proof.reason}`;
    case "carried": return `${kind}: evidence of ${short(proof.from)} carried across ${proof.merges} clean merge(s) of the base`;
    case "gap": return `${kind}: ${gapText(proof.gap)}`;
    case "missing": return proof.newest
      ? `${kind}: missing at HEAD; the newest evidence is at ${short(proof.newest)}. Save new evidence, or run hedge proof save --kind ${kind} --reuse-from ${short(proof.newest)} --reason <why it still proves HEAD>`
      : `${kind}: missing`;
  }
}

const evidenceDirectory = (home: string, identity: ProofIdentity, kind: ProofKind, proof: Proved) => proof.directory ?? join(pullRequestDirectory(home, identity), proof.reuse!.from, kind);
const evidenceState = (identity: ProofIdentity, proof: Proved, directory: string): KindState =>
  proof.reuse ? { state: "reused", from: proof.reuse.from, reason: proof.reuse.reason, directory } : { state: "ran", commit: identity.commit, directory };

type KindStatus = Pick<Status, "problem" | "condition" | "lapsed"> & { proof: KindProof; evidence?: string; dev?: DevResult };

const kindStatusOf = (kind: ProofKind, problem: Status["problem"], state: KindState, evidence?: string): KindStatus =>
  ({ problem, proof: { kind, line: kindLine(kind, state), ...state } as KindProof, evidence });

async function kindStatus(weigh: Weigh, kind: ProofKind, landed: boolean, cleanBaseMerge: CleanBaseMerge, dev?: DevState): Promise<KindStatus> {
  if (kind === "dev-observed") return devObservedStatus(weigh, cleanBaseMerge, dev);
  const { home, identity, decisions } = weigh;
  const status = (problem: Status["problem"], state: KindState, evidence?: string) => kindStatusOf(kind, problem, state, evidence);
  if (kind === "post-deploy-watch" && !landed) return status(undefined, { state: "pending" });
  const gap = await readJson<Gap | undefined>(gapPath(home, identity, kind), undefined);
  const weighed = await gapAcceptance(weigh, gap, kind);
  const acceptance = weighed.acceptance;
  const gapState = (): KindState => ({ state: "gap", accepted: acceptance !== undefined, gap: gapProof(gap, weighed, decisions) });
  if (acceptance?.by === "the user") return { ...status(undefined, gapState()), ...countedGap(weighed) };
  const proved = await provedCommits(home, identity, kind);
  const head = proved.get(identity.commit);
  if (head) { const directory = evidenceDirectory(home, identity, kind, head); return status(undefined, evidenceState(identity, head, directory), directory); }
  const carried = reviewedThroughMerges(identity.commit, new Set(proved.keys()), cleanBaseMerge);
  if (carried) {
    const proof = proved.get(carried.from)!;
    const directory = evidenceDirectory(home, identity, kind, proof);
    return status(undefined, { state: "carried", from: carried.from, origin: proof.reuse?.from ?? carried.from, merges: carried.merges.length, directory }, directory);
  }
  if (gap) return { ...status(acceptance ? undefined : "gap", gapState()), ...countedGap(weighed) };
  const newest = [...proved].sort(([, a], [, b]) => (a.time < b.time ? 1 : -1))[0]?.[0];
  return { ...status("missing", newest ? { state: "missing", newest } : { state: "missing" }), ...lapseOf(weighed) };
}

/** The dev PR as GitHub shows it: mergedAt once it merged. */
export type DevPull = { mergedAt?: string; mergeCommit?: string };
type DevState = DevPull & { ref: DevPr; error?: string };
/** The dev result in the proof summary, once dev-observed evidence saved after the dev merge counts. */
export type DevResult = { pr: string; mergedAt: string; mergeCommit?: string; savedAt: string; line: string };

const nanosOf = (iso: string) => BigInt(Date.parse(iso)) * 1_000_000n;
const isoOf = (nanos: bigint) => new Date(Number(nanos / 1_000_000n)).toISOString();

/**
 * dev-observed counts only evidence saved after the dev PR merged: an observation before the merge saw the old dev.
 * Until then the kind waits on the dev result, and a gap stands in as for any kind.
 */
async function devObservedStatus(weigh: Weigh, cleanBaseMerge: CleanBaseMerge, dev: DevState | undefined): Promise<KindStatus> {
  const { home, identity, decisions } = weigh;
  const kind = "dev-observed";
  const status = (problem: Status["problem"], state: KindState, evidence?: string) => kindStatusOf(kind, problem, state, evidence);
  const gap = await readJson<Gap | undefined>(gapPath(home, identity, kind), undefined);
  const weighed = await gapAcceptance(weigh, gap, kind);
  const acceptance = weighed.acceptance;
  const gapState = (): KindState => ({ state: "gap", accepted: acceptance !== undefined, gap: gapProof(gap, weighed, decisions) });
  if (acceptance?.by === "the user") return { ...status(undefined, gapState()), ...countedGap(weighed) };
  const proved = await provedCommits(home, identity, kind);
  const head = proved.get(identity.commit);
  const carried = head ? undefined : reviewedThroughMerges(identity.commit, new Set(proved.keys()), cleanBaseMerge);
  const found = head ?? (carried && proved.get(carried.from));
  const directory = found && evidenceDirectory(home, identity, kind, found);
  const saved = directory ? await newestFile(directory) : undefined;
  if (dev?.mergedAt && found && directory && saved !== undefined && saved >= nanosOf(dev.mergedAt)) {
    const result: DevResult = {
      pr: devText(dev.ref), mergedAt: dev.mergedAt, ...dev.mergeCommit ? { mergeCommit: dev.mergeCommit } : {}, savedAt: isoOf(saved),
      line: `dev result: ${devText(dev.ref)} merged at ${dev.mergedAt}${dev.mergeCommit ? ` as ${short(dev.mergeCommit)}` : ""}; the dev-observed evidence was saved at ${isoOf(saved)}, after the merge`,
    };
    const state: KindState = head ? evidenceState(identity, head, directory) : { state: "carried", from: carried!.from, origin: found.reuse?.from ?? carried!.from, merges: carried!.merges.length, directory };
    return { ...status(undefined, state, directory), dev: result };
  }
  if (gap) return { ...status(acceptance ? undefined : "gap", gapState()), ...countedGap(weighed) };
  const merged = dev?.mergedAt && `the dev PR merged at ${dev.mergedAt}${dev.mergeCommit ? ` as ${short(dev.mergeCommit)}` : ""}`;
  const reason = !dev ? "no dev PR is recorded; run hedge proof require --after-dev <owner/name>#<number>"
    : dev.error ? `cannot read the dev PR (${dev.error})`
    : !merged ? "the dev PR is not merged yet"
    : saved !== undefined ? `${merged}, after the newest dev-observed evidence, saved at ${isoOf(saved)}. Observe dev again and save the result with hedge proof run --kind dev-observed -- <command>`
    : `${merged}. Observe dev and save the result with hedge proof run --kind dev-observed -- <command>`;
  return { ...status("missing", { state: "waiting", dev: dev ? devText(dev.ref) : "an unrecorded dev PR", reason }), ...lapseOf(weighed) };
}

type FinishedReview = { name: string; commit: string; reviewer?: string; finishedAt: bigint; panel: boolean; scope?: string; from?: string; forkBase?: string };

export async function finishedReviews(home: string, identity: ProofIdentity) {
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  const finished: FinishedReview[] = [];
  for (const name of await reviewNames(reviews)) {
    const reservation = await readJson<(ProofIdentity & { reviewer?: string; capturedBy?: CapturedBy; scope?: string; from?: string; forkBase?: string }) | undefined>(join(reviews, name, "round.json"), undefined);
    const findings = await stat(join(reviews, name, "findings.md"), { bigint: true }).catch(() => undefined);
    const panel = await panelOutcome(join(reviews, name));
    const counted = panel === "none" || (panel === "finished" && reservation?.capturedBy === "hedge");
    if (reservation && findings && counted) finished.push({ name, commit: reservation.commit, reviewer: reservation.reviewer, finishedAt: findings.mtimeNs, panel: panel === "finished", scope: reservation.scope, from: reservation.from, forkBase: reservation.forkBase });
  }
  return finished.sort((a, b) => (a.finishedAt < b.finishedAt ? -1 : a.finishedAt > b.finishedAt ? 1 : 0));
}

const reviewLabel = (name: string) => name.startsWith(finalReadPrefix) ? `final read ${name.slice(finalReadPrefix.length)}` : `round ${name}`;

export type CleanBaseMerge = (commit: string) => string | undefined;
export type QuietCommit = (commit: string) => QuietStep | undefined;
type Carried = { commit: string; from: string; merges: string[]; quiet?: string[]; reason?: string; recordedAt: string };
const carriedPath = (home: string, identity: ProofIdentity, commit: string) => join(pullRequestDirectory(home, identity), "carried", `${commit}.json`);
const maxCarriedMerges = 20;
const maxQuietCommits = 30;

function reviewedThroughMerges(start: string, reviewed: Set<string>, cleanBaseMerge: CleanBaseMerge) {
  const found = reviewedThrough(start, reviewed, cleanBaseMerge, () => undefined);
  return found && { from: found.from, merges: found.merges };
}

function reviewedThrough(start: string, reviewed: Set<string>, cleanBaseMerge: CleanBaseMerge, quietCommit: QuietCommit) {
  const merges: string[] = [];
  const quiet: string[] = [];
  const kinds = new Set<DeltaKind>();
  const cancelled = new Map<string, string>();
  let commit: string | undefined = start;
  while (commit && merges.length <= maxCarriedMerges && quiet.length <= maxQuietCommits) {
    const undone = cancelled.get(commit);
    if (undone) { cancelled.delete(commit); commit = undone; continue; }
    if (reviewed.has(commit) && !cancelled.size) return { from: commit, merges, quiet, kinds: [...kinds] };
    const merged = cleanBaseMerge(commit);
    if (merged) { merges.push(commit); commit = merged; continue; }
    const step = quietCommit(commit);
    if (!step) return undefined;
    quiet.push(commit);
    if (step.cancels) cancelled.set(step.cancels.commit, step.cancels.parent);
    step.kinds.forEach((kind) => kinds.add(kind));
    commit = step.parent;
  }
  return undefined;
}

function gateCarry(identity: ProofIdentity, finished: FinishedReview[], cleanBaseMerge: CleanBaseMerge, quietCommit: QuietCommit) {
  const firstPanel = finished.find((review) => review.panel);
  const counted = firstPanel ? finished.filter((review) => review.finishedAt >= firstPanel.finishedAt) : finished;
  return { counted, found: reviewedThrough(identity.commit, new Set(counted.map((review) => review.commit)), cleanBaseMerge, quietCommit) };
}

async function carryForward(home: string, identity: ProofIdentity, found: ReturnType<typeof reviewedThrough>) {
  if (!found || (!found.merges.length && !found.quiet.length)) return undefined;
  const quiet = found.quiet.length ? { quiet: found.quiet, reason: quietReason(found.kinds) } : {};
  const carried: Carried = { commit: identity.commit, from: found.from, merges: found.merges, ...quiet, recordedAt: new Date().toISOString() };
  await writeJson(carriedPath(home, identity, identity.commit), carried);
  return carried;
}

const panelHint = "Run hedge proof review, which runs the lenses of the PR's review tier, or, for a PR that the user's rules exempt from the swarm, record hedge proof gap --kind panel --reason <the exception>";

async function reviewStatus(weigh: Weigh, cleanBaseMerge: CleanBaseMerge, quietCommit: QuietCommit): Promise<Status & { panelGap?: GapProof }> {
  const { home, identity, decisions } = weigh;
  const all = await finishedReviews(home, identity);
  const carry = gateCarry(identity, all, cleanBaseMerge, quietCommit);
  if (all.some((review) => review.panel)) return headReview(home, identity, carry);
  const gap = await readJson<Gap | undefined>(gapPath(home, identity, "panel"), undefined);
  const weighed = await gapAcceptance(weigh, gap, "panel");
  const acceptance = weighed.acceptance;
  if (!gap && acceptance?.by !== "the user") return { problem: "missing", line: `review: no finished panel round on the PR${all.length ? `; ${all.length} single-reviewer review(s) do not count` : ""}. ${panelHint}`, ...lapseOf(weighed) };
  const panelGap = gapProof(gap, weighed, decisions);
  const line = `panel ${gapText(panelGap)}`;
  const head = await headReview(home, identity, carry);
  if (!acceptance) return { problem: head.problem ?? "gap", line: `${head.line}; ${line}`, panelGap, ...countedGap(weighed) };
  return { ...head, line: `${head.line}; ${line}`, covered: head.covered && `${head.covered}, ${line}`, panelGap, ...countedGap(weighed) };
}

async function headReview(home: string, identity: ProofIdentity, { counted: finished, found }: ReturnType<typeof gateCarry>): Promise<Status> {
  const head = finished.filter((review) => review.commit === identity.commit).at(-1);
  if (head) {
    const covered = `${reviewLabel(head.name)}${head.reviewer ? ` by ${head.reviewer}` : ""}`;
    return { problem: undefined, line: `review: HEAD reviewed in ${covered}`, covered };
  }
  const carried = await carryForward(home, identity, found);
  if (carried?.reason) {
    const review = finished.filter((done) => done.commit === carried.from).at(-1)!;
    const merges = carried.merges.length ? ` and ${carried.merges.length} clean merge(s) of the base` : "";
    const covered = `final read carried from ${short(carried.from)}: ${carried.reason}`;
    return { problem: undefined, line: `review: ${covered} (${reviewLabel(review.name)}${review.reviewer ? ` by ${review.reviewer}` : ""}; ${carried.quiet!.length} quiet commit(s)${merges})`, covered };
  }
  if (carried) return { problem: undefined, line: `review: HEAD carried forward from the review of ${short(carried.from)} across ${carried.merges.length} clean merge(s) of the base`, covered: `carried from ${short(carried.from)}` };
  const latest = finished.at(-1);
  return { problem: "missing", line: latest ? `review: HEAD not reviewed, last review covered ${short(latest.commit)}` : "review: HEAD not reviewed" };
}

async function responseStatuses(home: string, identity: ProofIdentity, body: string | undefined): Promise<Status[]> {
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  const statuses = await Promise.all((await finishedReviews(home, identity)).map(async ({ name }): Promise<Status | undefined> => {
    const findings = await readFile(join(reviews, name, "findings.md"), "utf8");
    const responses = await readFile(join(reviews, name, "responses.md"), "utf8").catch(() => "");
    const missing = unanswered(findings, responses);
    if (missing.length) return { problem: "missing", line: `review: ${reviewLabel(name)} has unanswered findings ${missing.join(", ")}; answer each with hedge proof respond --round ${name} <responses.md>` };
    const unlisted = body === undefined ? [] : unlistedKnown(findings, responses, knownIssues(body));
    if (unlisted.length) return { problem: "missing", line: `known issues: ${reviewLabel(name)} answers findings ${unlisted.join(", ")} known, but the "## Known issues" section of the PR body does not list their file:line` };
    const blockers = knownBlockers(findings, responses);
    return blockers.length ? { problem: "missing", line: `known issues: ${reviewLabel(name)} answers findings ${blockers.join(", ")} known, and an open blocker holds the merge` } : undefined;
  }));
  return statuses.filter((status) => status !== undefined);
}

export type CiResult = { state: "green" | "red" | "pending" | "none" | "unknown"; detail: string; checks?: string[] };

type CiStatus = Omit<Status, "problem"> & { problem: Status["problem"] | "pending"; gap?: GapProof };

async function ciStatus(weigh: Weigh, ci: CiResult): Promise<CiStatus> {
  const { home, identity, decisions } = weigh;
  const line = `ci: ${ci.state}, ${ci.detail}`;
  if (ci.state === "green") return { problem: undefined, line, covered: "green" };
  const gap = await readJson<Gap | undefined>(gapPath(home, identity, "ci"), undefined);
  const weighed = await gapAcceptance({ ...weigh, ci }, gap, "ci");
  if (!gap && weighed.acceptance?.by !== "the user") return ci.state === "pending" ? { problem: "pending", line, ...lapseOf(weighed) } : { problem: "missing", line: `${line}. Fix it, or record hedge proof gap --kind ci --reason <why CI cannot run> when it cannot run here`, ...lapseOf(weighed) };
  const recorded = gapProof(gap, weighed, decisions);
  return { problem: weighed.acceptance ? undefined : "gap", line: `${line}; ${gapText(recorded)}`, covered: "gap accepted", gap: recorded, ...countedGap(weighed) };
}

export const ciRunningCode = 75;
const gateCodes = { missing: 1, gap: 3, pending: ciRunningCode } as const;

export type PushedHead = { commit: string; body?: string } | { error: string };

function headStatus(identity: ProofIdentity, before: PushedHead, after: PushedHead): Status {
  if ("error" in before) return { problem: "missing", line: `head: cannot read the PR head on GitHub (${before.error})` };
  if (before.commit !== identity.commit) return { problem: "missing", line: `head: ${short(identity.commit)} is not the PR's head on GitHub (${short(before.commit) || "none"}); push it` };
  if ("error" in after) return { problem: "missing", line: `head: cannot read the PR head on GitHub again (${after.error})` };
  if (after.commit !== before.commit) return { problem: "missing", line: `head: the PR head moved to ${short(after.commit)} while the gate read CI; run the gate again` };
  return { problem: undefined, line: `head: ${short(identity.commit)} is the PR's head on GitHub` };
}

/** devPull reads the dev PR that a prod PR waits on (hedge proof require --after-dev). */
export type GateOptions = { ci: () => CiResult; pushedHead: () => PushedHead; ledger: Ledger; landed?: boolean; cleanBaseMerge?: CleanBaseMerge; quietCommit?: QuietCommit; now?: Date; devPull?: (dev: DevPr) => DevPull | Promise<DevPull> };

// A fenced block is an example, never the section: drop it before looking for the heading.
const unfenced = (body: string) => body.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "");
const knownIssues = (body: string) => (/^#+\s*Known issues\b.*$([\s\S]*?)(?=^#|(?![\s\S]))/im.exec(unfenced(body))?.[1] ?? "").split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).map((line) => line.trim());
const knownBlocker = (body: string) => knownIssues(body).find((line) => /^[-*]\s+\**blocker\b/i.test(line));

function heldStatus(head: PushedHead): Status | undefined {
  const blocker = "body" in head && head.body !== undefined ? knownBlocker(head.body) : undefined;
  return blocker ? { problem: "missing", line: `known issues: an open blocker holds the merge: ${blocker}` } : undefined;
}

export type ProofSummary = {
  repository: string; pr: number; commit: string; tier: Tier; code: number;
  owed: { state: "unrecorded" | "none" | "owed"; kinds: ProofKind[]; reason?: string; line?: string };
  kinds: KindProof[];
  /** The dev PR's merge and when its observed result was saved, once dev-observed evidence counts. */
  dev?: DevResult;
  review: { state: "covered" | "missing" | "gap"; covered?: string; panelGap?: GapProof; unanswered: string[]; line: string; dropped?: string[] };
  head: { state: "pushed" | "missing"; line: string };
  ci: { state: CiResult["state"]; detail: string; checks?: string[]; gap?: GapProof; line: string };
  judge: JudgeSummary;
  lapsed: string[]; lapsedLine?: string; voided: string[]; receipt?: string; held?: string; growth?: Growth;
};

export type JudgeSummary = { state: "pass" | "fail" | "unavailable" | "skipped"; model?: string; gap?: GapProof; lines: string[] };
export type CheckedSummary = Omit<ProofSummary, "judge">;

export const summaryGaps = (summary: ProofSummary): { kind: string; gap: GapProof }[] => [
  ...summary.kinds.flatMap((kind) => kind.state === "gap" ? [{ kind: kind.kind as string, gap: kind.gap }] : []),
  ...summary.review.panelGap ? [{ kind: "panel", gap: summary.review.panelGap }] : [],
  ...summary.ci.gap ? [{ kind: "ci", gap: summary.ci.gap }] : [],
  ...summary.judge.gap ? [{ kind: "judge", gap: summary.judge.gap }] : [],
];

export const summaryLines = (summary: CheckedSummary) => [
  ...summary.owed.line ? [summary.owed.line] : [], ...summary.kinds.map((kind) => kind.line), ...summary.dev ? [summary.dev.line] : [], summary.review.line, ...summary.review.dropped ?? [], ...summary.review.unanswered,
  summary.head.line, summary.ci.line, ...summary.lapsedLine ? [summary.lapsedLine] : [], ...summary.held ? [summary.held] : [],
];

const owedPart = (owed: Owed | undefined): CheckedSummary["owed"] =>
  !owed ? { state: "unrecorded", kinds: [], line: "owed proofs: not recorded; run hedge proof require --kinds <kind,kind> or hedge proof require --none --reason <why>" }
  : !owed.kinds.length ? { state: "none", kinds: [], ...owed.none ? { reason: owed.none.reason } : {}, line: `owed proofs: none (${owed.none?.reason ?? "no reason recorded"})` }
  : { state: "owed", kinds: owed.kinds };

const lapsedLine = (ids: string[]) => ids.length ? `lapsed: ${ids.map((id) => `🤖 decision ${id}`).join(", ")} no longer count${ids.length === 1 ? "s" : ""}; ask the user, or decide again once the reason is gone` : undefined;

async function readDev(dev: DevPr | undefined, devPull: GateOptions["devPull"]): Promise<DevState | undefined> {
  if (!dev) return undefined;
  if (!devPull) return { ref: dev, error: "no GitHub reader here" };
  try { return { ref: dev, ...await devPull(dev) }; }
  catch (error) { return { ref: dev, error: (error as Error).message.trim().split("\n")[0] || "unknown error" }; }
}

export async function proofGate(home: string, identity: ProofIdentity, { ci, pushedHead, ledger, landed = false, cleanBaseMerge = () => undefined, quietCommit = () => undefined, now = new Date(), devPull }: GateOptions) {
  const before = pushedHead();
  const grade = gradeOf("error" in before ? undefined : before.body);
  const tier = grade.tier;
  const decisions = await readDecisions(ledger);
  const weigh: Weigh = { home, identity, now, decisions, tier };
  const owed = await readOwed(home, identity);
  const dev = owed?.kinds.includes("dev-observed") ? await readDev(owed.afterDev, devPull) : undefined;
  const kinds = await Promise.all((owed?.kinds ?? []).map((kind) => kindStatus(weigh, kind, landed, cleanBaseMerge, dev)));
  const devResult = kinds.find((kind) => kind.dev)?.dev;
  const review = await reviewStatus(weigh, cleanBaseMerge, quietCommit);
  const responses = await responseStatuses(home, identity, landed || !("body" in before) ? undefined : before.body ?? "");
  const dropped = (await droppedFinalReads(home, identity)).map(({ line, cause }) => `review: ${line}${cause ? "; hedge proof show prints its cause" : ""}`);
  const ciResult = ci();
  const head = headStatus(identity, before, pushedHead());
  const checks = await ciStatus(weigh, ciResult);
  const knownHold = landed ? undefined : heldStatus(before);
  const held = [{ problem: owed ? undefined : "missing", line: owedPart(owed).line }, ...kinds.map((kind) => ({ problem: kind.problem, line: kind.proof.line })), review, ...responses, head, checks, ...knownHold ? [knownHold] : []];
  const weighed = [...kinds, review, checks];
  const lapsed = [...new Set(weighed.flatMap((status) => status.problem && status.lapsed ? [status.lapsed] : []))];
  const conditions = weighed.flatMap((status) => status.condition ? [status.condition] : []);
  const holding = (["missing", "gap", "pending"] as const).find((problem) => held.some((status) => status.problem === problem));
  const code = holding ? gateCodes[holding] : 0;
  const failure = holding === "pending" ? `CI is still running: ${ciResult.detail}` : held.find((status) => status.problem === holding)?.line?.split("\n")[0];
  const voided = (Array.isArray(decisions) ? decisions : []).filter((decision) => decision.voided && covers(decision, identity)).map((decision) => decision.id);
  const receipt = await receiptOf(home, identity);
  const proofSummary: CheckedSummary = {
    repository: identity.repository, pr: identity.pr, commit: identity.commit, tier, code, owed: owedPart(owed), kinds: kinds.map((kind) => kind.proof), ...devResult ? { dev: devResult } : {},
    review: { state: review.problem ?? "covered", ...review.covered ? { covered: review.covered } : {}, ...review.panelGap ? { panelGap: review.panelGap } : {}, unanswered: responses.map((response) => response.line), line: review.line, ...dropped.length ? { dropped } : {} },
    head: { state: head.problem ? "missing" : "pushed", line: head.line },
    ci: { state: ciResult.state, detail: ciResult.detail, ...ciResult.checks ? { checks: ciResult.checks } : {}, ...checks.gap ? { gap: checks.gap } : {}, line: checks.line },
    lapsed, ...lapsed.length ? { lapsedLine: lapsedLine(lapsed) } : {}, voided, ...receipt ? { receipt } : {}, ...knownHold ? { held: knownHold.line } : {},
  };
  const summary = `kinds: ${owed?.kinds.length ? owed.kinds.join(", ") : "none"}; review: ${review.covered}; CI: ${checks.covered}`;
  const evidence = kinds.map(({ proof, evidence }) => ({ kind: proof.kind, line: proof.line, directory: evidence }));
  return { code, failure, lines: summaryLines(proofSummary), summary, owed, evidence, ci: ciResult, decisions, tier, grade, conditions, voided, proofSummary };
}

const receiptPath = (home: string, ref: PrRef) => join(prDirectory(home, ref), "receipt.json");
export const receiptOf = async (home: string, ref: PrRef) => (await readJson<{ url?: string } | undefined>(receiptPath(home, ref), undefined))?.url;
export const recordReceipt = (home: string, ref: PrRef, url: string) => writeJson(receiptPath(home, ref), { url });

export async function reviewRecords(home: string, identity: ProofIdentity) {
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  return Promise.all((await finishedReviews(home, identity)).map(async ({ name, commit, reviewer }) => {
    const reservation = await readJson<Reservation | undefined>(join(reviews, name, "round.json"), undefined);
    return {
      label: reviewLabel(name), directory: join(reviews, name), commit, reviewer, capturedBy: reservation?.capturedBy ?? "author",
      findings: await readFile(join(reviews, name, "findings.md"), "utf8"),
      responses: await readFile(join(reviews, name, "responses.md"), "utf8").catch(() => undefined),
    };
  }));
}

export const panelCommit = async (home: string, identity: ProofIdentity) => (await finishedReviews(home, identity)).find((review) => review.panel)?.commit;

export async function reviewOfCommit(home: string, identity: ProofIdentity) {
  const review = (await finishedReviews(home, identity)).filter((finished) => finished.commit === identity.commit).at(-1);
  if (!review) return undefined;
  const reservation = await readJson<Reservation | undefined>(join(pullRequestDirectory(home, identity), "reviews", review.name, "round.json"), undefined);
  return { label: reviewLabel(review.name), scope: reservation?.scope ?? "full", from: reservation?.from ?? reservation?.base, reviewer: review.reviewer };
}

export const judgeDirectory = (home: string, identity: ProofIdentity) => join(pullRequestDirectory(home, identity), "judge");
