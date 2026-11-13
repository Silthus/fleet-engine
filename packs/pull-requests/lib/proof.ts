import { createHash } from "node:crypto";
import { access, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { normalized, type HeardAnswer } from "./proof-answers.ts";
import { agentRefusal, agentsAcceptance, covers, fold, keptOwed, panelRefusal, tierOf, usersAcceptance, type Decision, type DecisionState, type Ledger, type Mark, type Tier } from "./decision-ledger.ts";
import type { Family } from "./proof-models.ts";
import { quietReason, type DeltaKind, type QuietStep } from "./proof-delta.ts";

export type ProofIdentity = { repository: string; pr: number; commit: string };
const sha = /^[0-9a-f]{40}$/;
export const ledgerRoot = (home: string) => join(home, ".local/state/fleet/proof");

export function pullRequestDirectory(home: string, identity: ProofIdentity) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(identity.repository) || identity.repository.split("/").some((part) => part === "." || part === "..")) throw new Error(`Invalid repository ${identity.repository || "(none)"}. Use owner/name`);
  if (!Number.isSafeInteger(identity.pr) || identity.pr < 1 || !sha.test(identity.commit)) throw new Error("Use a positive PR number and a full commit SHA");
  return join(ledgerRoot(home), identity.repository, String(identity.pr));
}

export function proofDirectory(home: string, identity: ProofIdentity) {
  return join(pullRequestDirectory(home, identity), identity.commit);
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

async function reserve(reviews: string, name: string, record: object) {
  const temporary = join(reviews, `.reservation-${crypto.randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writeFile(join(temporary, "round.json"), JSON.stringify({ ...record, startedAt: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
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

async function finalReadsInPhase(reviews: string, started: string[], phase: FinalReadPhase) {
  const reads = started.filter((name) => name.startsWith(finalReadPrefix));
  const phases = await Promise.all(reads.map(async (name) => (JSON.parse(await readFile(join(reviews, name, "round.json"), "utf8")) as { phase?: FinalReadPhase }).phase ?? "review"));
  return phases.filter((readPhase) => readPhase === phase).length;
}

export type ArbiterVerdict = { verdict: "continue" | "escalate" | "unavailable"; reason: string; model: string };
export type Arbiter = (prompt: string) => Promise<ArbiterVerdict>;

const arbiterInstructions = `You decide if a code review loop may run one more review. Below are the findings of every finished review of one pull request, oldest first, each with the author's responses when there are any. A panel review has one section per lens.

Answer ESCALATE only in one of these cases:
1. A later finding asks to undo, or contradicts, what an earlier finding asked for. The reviewers disagree, so a human must choose.
2. The same finding comes back in a later review after it was reported and fixed. The loop does not converge.

fleet ends some findings with an Anchor check. Its "Seen before" lines name findings that quote the same changed line as a finding of an earlier review: weigh them for case 2.

In all other cases answer CONTINUE. New findings, many findings, or findings about new code are not a reason to escalate. A finding whose earlier fix the author's response moved into the module that owns the concept is progress, not a loop.

Your first line must be exactly CONTINUE, or ESCALATE: followed by one sentence that names the findings and their reviews. Write nothing else.`;
const findingsCap = 16_000;
const responsesCap = 4000;
const cut = (text: string, cap: number) => text.length > cap ? text.slice(0, cap) + "\n[truncated]" : text;

async function arbiterPrompt(home: string, identity: ProofIdentity) {
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  const sections = await Promise.all((await finishedReviews(home, identity)).map(async ({ name }) => {
    const findings = (await readFile(join(reviews, name, "findings.md"), "utf8")).trim();
    const responses = (await readFile(join(reviews, name, "responses.md"), "utf8").catch(() => "")).trim();
    return `# ${reviewLabel(name)}\n\n${cut(findings, findingsCap)}${responses ? `\n\n# Responses to ${reviewLabel(name)}\n\n${cut(responses, responsesCap)}` : ""}`;
  }));
  return [arbiterInstructions, ...sections].join("\n\n");
}

export function parseVerdict(output: string, model: string): ArbiterVerdict {
  const line = (output.split("\n").find((text) => text.trim()) ?? "").replace(/^[\s*`]+|[\s*`]+$/g, "");
  if (output.trim().replace(/^[*`]+|[*`]+$/g, "") === "CONTINUE") return { verdict: "continue", reason: "", model };
  const escalate = /^ESCALATE:\s*(\S.*)$/.exec(line);
  if (escalate) return { verdict: "escalate", reason: escalate[1]!.replace(/\.$/, ""), model };
  return { verdict: "unavailable", reason: `unparseable answer: ${line.slice(0, 200)}`, model };
}

export type ReviewLimits = { free: number; ceiling: number };

async function permitReview(home: string, identity: ProofIdentity, due: boolean, ceiling: string | undefined, decision: DecisionMark | undefined, { arbiter }: Permit) {
  if (decision?.mark === "👤") return undefined;
  if (ceiling && !decision) throw new Error(askUser(identity, ceiling));
  if (!due) return undefined;
  const verdict = await arbiter(await arbiterPrompt(home, identity));
  if (verdict.verdict !== "continue" && !decision) throw new Error(askUser(identity, verdict.verdict === "escalate" ? `The arbiter escalates: ${verdict.reason}.` : `The arbiter gave no verdict: ${verdict.reason}.`));
  return verdict;
}

export const roundQuestion = "Run one more review round?";
export const runOption = "Run one more round";
export const stopOption = "Stop here";

function askUser(identity: ProofIdentity, stop: string) {
  return `${stop} Ask the user with your question tool. Question: "${roundQuestion} ${identity.repository}#${identity.pr}: ${stop}" Options: "${runOption}", "${stopOption}". When they choose "${runOption}", run this command again with --override '<date> "${runOption}"'. Or decide the round yourself with --agent '<your reason>', a 🤖 review decision in the ledger, when the PR's tier lets you.`;
}

export type CapturedBy = "fleet" | "author";
export type DecisionMark = Pick<Decision, "mark" | "id">;
export type ReviewRequest = { scope: string; base?: string; from?: string; decision?: Decision; phase?: string; arbiter: Arbiter; limits: ReviewLimits; cleanBaseMerge?: CleanBaseMerge; quietCommit?: QuietCommit; capturedBy?: CapturedBy };
export type Reserved = { round: number | "final"; id: string; directory: string };
type Permit = { arbiter: Arbiter; limits: ReviewLimits };

const reserveDecided = (reviews: string, name: string, record: object, decision: Decision | undefined) => reserve(reviews, name, { ...record, ...decision ? { decision } : {} });

async function startFinalRead(home: string, identity: ProofIdentity, base: string | undefined, decision: Decision | undefined, phase: FinalReadPhase, permit: Permit, cleanBaseMerge: CleanBaseMerge, quietCommit: QuietCommit, capturedBy: CapturedBy, from: string | undefined): Promise<Reserved> {
  if (base === undefined) throw new Error("A final read needs --base with the latest reviewed commit");
  if (base === identity.commit) throw new Error("HEAD is already reviewed. Skip the final read.");
  const quiet = decision ? undefined : reviewedThrough(identity.commit, new Set([base]), cleanBaseMerge, quietCommit);
  if (quiet?.quiet.length) throw new Error(`HEAD needs no final read: final read carried from ${short(base)}: ${quietReason(quiet.kinds)}. fleet proof gate counts the carry. To read it anyway, pass --agent '<your reason>', or the user's --override`);
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  for (let attempt = 1; attempt <= 100; attempt++) {
    const started = await reviewNames(reviews);
    const finished = await finishedReviews(home, identity);
    if (finished.length < started.length) throw new Error("A review is unfinished. Finish it before a final read.");
    const latest = finished.at(-1);
    if (!latest) throw new Error("A final read needs a finished earlier review");
    if (!coversReview(base, latest.commit, cleanBaseMerge)) throw new Error(`Final read base must be the latest reviewed commit ${latest.commit}, or a clean base merge the gate carried it to`);
    const done = await finalReadsInPhase(reviews, started, phase);
    const { free, ceiling } = permit.limits;
    const stop = done >= ceiling ? `The loop did not converge: ${ceiling} final reads done in the ${phase} phase.` : undefined;
    const verdict = await permitReview(home, identity, done >= free, stop, decision, permit);
    let read = 1;
    while (started.includes(finalReadPrefix + read)) read++;
    const name = finalReadPrefix + read;
    if (await reserveDecided(reviews, name, { ...identity, round: "final", read, scope: "final", base, from, phase, arbiter: verdict, capturedBy }, decision)) return { round: "final", id: name, directory: join(reviews, name) };
  }
  throw new Error("Final read limit exceeded");
}

const coversReview = (base: string, reviewed: string, cleanBaseMerge: CleanBaseMerge) => reviewedThroughMerges(base, new Set([reviewed]), cleanBaseMerge) !== undefined;

export async function startReview(home: string, identity: ProofIdentity, request: ReviewRequest): Promise<Reserved> {
  const { scope, base, phase, decision, cleanBaseMerge = () => undefined, quietCommit = () => undefined, capturedBy = "author" } = request;
  const from = request.from ?? base;
  const permit = { arbiter: request.arbiter, limits: request.limits };
  if (!["full", "fixes", "final"].includes(scope)) throw new Error("Review scope must be full, fixes, or final");
  if (phase !== undefined && scope !== "final") throw new Error("--phase applies only to final reads");
  if (base !== undefined && !sha.test(base)) throw new Error("Review base needs a full commit SHA");
  if (base !== undefined && scope === "full") throw new Error("--scope full reads the diff from the merge base. Drop --base");
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  await mkdir(reviews, { recursive: true, mode: 0o700 });
  if (scope === "final") return startFinalRead(home, identity, base, decision, finalReadPhase(phase ?? "review"), permit, cleanBaseMerge, quietCommit, capturedBy, from);
  return startRound(home, identity, reviews, { scope, base, from, decision, permit, cleanBaseMerge, capturedBy });
}

type RoundStart = { scope: string; base?: string; from?: string; decision: Decision | undefined; permit: Permit; cleanBaseMerge: CleanBaseMerge; capturedBy: CapturedBy };

async function startRound(home: string, identity: ProofIdentity, reviews: string, { scope, base, from, decision, permit, cleanBaseMerge, capturedBy }: RoundStart): Promise<Reserved> {
  for (let round = 1; round <= 100; round++) {
    const directory = join(reviews, String(round));
    try { await access(directory); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (round === 1 && scope !== "full") throw new Error("Round 1 is --scope full: it reviews the whole PR diff. Drop --base");
    if (round > 1) await checkLaterRound(reviews, round, scope, base, decision, cleanBaseMerge);
    const { free, ceiling } = permit.limits;
    const stop = round > ceiling ? `The loop did not converge: ${ceiling} panel rounds done.` : undefined;
    const verdict = await permitReview(home, identity, round > free, stop, decision, permit);
    if (await reserveDecided(reviews, String(round), { ...identity, round, scope, base, from, arbiter: verdict, capturedBy }, decision)) return { round, id: String(round), directory };
  }
  throw new Error("Review limit exceeded");
}

type Claim = { repository: string; pr: number };
const claimPath = (home: string, answer: HeardAnswer) => join(ledgerRoot(home), "claims", `${createHash("sha256").update(`${answer.thread}/${answer.message}`).digest("hex")}.json`);

async function checkLaterRound(reviews: string, round: number, scope: string, base: string | undefined, decision: DecisionMark | undefined, cleanBaseMerge: CleanBaseMerge) {
  try { await access(join(reviews, String(round - 1), "findings.md")); }
  catch { throw new Error("Previous review round is unfinished. Reuse its reservation before starting another panel."); }
  if (scope === "full" && decision) return;
  const previous = JSON.parse(await readFile(join(reviews, String(round - 1), "round.json"), "utf8")) as ProofIdentity;
  if (scope !== "fixes" || !base) throw new Error(`Round ${round} needs --scope fixes --base ${previous.commit}, the commit of round ${round - 1}. With --agent '<your reason>', or the user's --override, --scope full reviews the whole PR diff again`);
  if (!coversReview(base, previous.commit, cleanBaseMerge)) throw new Error(`Round ${round} needs --base ${previous.commit}, the commit of round ${round - 1}`);
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

export const recordGapCommand = (identity: ProofIdentity, kind: string) => `fleet decision record --mark 👤 --class proof-gap --kind ${kind} --pr ${identity.repository}#${identity.pr}`;

export function askGap(identity: ProofIdentity, kind: string, reason: string) {
  return `Ask the user with your question tool. Question: "${gapQuestion(identity, kind, reason)}" Options: "${acceptGapOption}", "${keepGapOption}". When they choose "${acceptGapOption}", run ${recordGapCommand(identity, kind)}`;
}

export function requireChoice(answer: HeardAnswer, lead: string, [accept, decline]: [string, string], refused: string) {
  if (answer.source !== "question") throw new Error(`"${answer.words}" is a message the user typed. Only their answer to your question tool counts: ask "${lead} …" with the options "${accept}" and "${decline}"`);
  if (!normalized(answer.answered).startsWith(normalized(lead))) throw new Error(`"${answer.words}" answers another question ("${answer.answered}"). Ask the question that fleet proof printed, which starts "${lead}"`);
  if (![accept, `${accept} (Recommended)`].map(normalized).includes(normalized(answer.words))) throw new Error(`The user chose "${answer.words}", not "${accept}". ${refused}`);
}

type RoundDecision = { decision?: Decision; recorded?: undefined } | { decision: DecisionMark; recorded: true };
export type Reservation = ProofIdentity & { round: number | "final"; scope: string; base?: string; from?: string; capturedBy?: CapturedBy; reviewer?: string } & RoundDecision;

export const readReservation = (directory: string) => readJson<Reservation | undefined>(join(directory, "round.json"), undefined);

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
    if (capturedBy === "fleet" && reservation.scope !== "full" && !reservation.base) { await rm(directory, { recursive: true, force: true }); continue; }
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
  if (!/^[\w.:@/+[\] -]+$/.test(reviewer) || !reviewer.trim()) throw new Error("--reviewer needs the model that wrote the findings, such as gpt-6.1-sol, in letters, digits and . : @ / + [ ] -");
  const bytes = await readFile(findings);
  if (!bytes.toString().trim()) throw new Error(`${findings} is empty. Save the reviewer's findings, or "No findings." when it found none`);
  const directory = await roundDirectory(home, identity, round);
  await storeFindings(directory, identity, round, bytes, reviewer.trim(), "author");
  return directory;
}

export async function storeCapturedFindings(directory: string, identity: ProofIdentity, round: RoundId, answer: string, reviewer: string) {
  await storeFindings(directory, identity, round, Buffer.from(answer.trim() + "\n"), reviewer, "fleet");
}

async function storeFindings(directory: string, identity: ProofIdentity, round: RoundId, bytes: Buffer, reviewer: string, capturedBy: CapturedBy) {
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
  await writeJson(join(directory, "round.json"), { ...await readReservation(directory) ?? reservation, reviewer, capturedBy });
}

export async function respondToReview(home: string, identity: ProofIdentity, round: RoundId, responses: string) {
  const bytes = await readFile(responses);
  if (!bytes.toString().trim()) throw new Error(`${responses} is empty. Answer each finding: fixed in which commit, or rejected and why`);
  const directory = await roundDirectory(home, identity, round);
  const findings = await readFile(join(directory, "findings.md"), "utf8").catch(() => undefined);
  if (findings === undefined) throw new Error(`Review round ${round} has no findings yet`);
  const missing = unanswered(findings, bytes.toString());
  if (missing.length) throw new Error(`Answer findings ${missing.join(", ")} too: one line each, numbered in the order of findings.md, such as "${missing[0]}. fixed in 1a2b3c4: <how>" or "${missing[0]}. rejected: <why>"`);
  const destination = join(directory, "responses.md");
  const temporary = `${destination}.${crypto.randomUUID()}`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
  return destination;
}

const findingItem = /^\s*(?:[-*]|\d+[.)])\s+\S/;
const answerItem = /^\s*(?:[-*]\s+)?(\d+)[.):]\s+\**(?:fixed|rejected)\b/gim;

const noFinding = /^(?:#.*|no findings\.?|findings:?|\(none\))$/i;

const findingsBlock = /^\s*FINDINGS\b:?/;

function reviewedLines(findings: string) {
  const lines = findings.split("\n");
  const lensAnswer = lines.some((line) => findingsBlock.test(line));
  let inside = !lensAnswer;
  return lines.flatMap((line) => {
    if (findingsBlock.test(line)) { inside = true; return [line.replace(findingsBlock, "")]; }
    if (/^COVERED\b/.test(line)) inside = false;
    else if (!lensAnswer && /^#/.test(line)) inside = true;
    return inside ? [line] : [];
  }).filter((line) => line.trim());
}

function findingCount(findings: string) {
  const reviewed = reviewedLines(findings);
  const items = reviewed.filter((line) => findingItem.test(line)).length;
  return items || (reviewed.every((line) => noFinding.test(line.trim())) ? 0 : 1);
}

function unanswered(findings: string, responses: string) {
  const answered = new Set([...responses.matchAll(answerItem)].map((match) => Number(match[1])));
  return Array.from({ length: findingCount(findings) }, (_, index) => index + 1).filter((number) => !answered.has(number));
}

export const proofKinds = ["live-run", "ui-walk", "prod-shape", "cross-version", "shadow-diff", "post-deploy-watch"] as const;
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

export type Owed = { kinds: ProofKind[]; none?: { reason: string; recordedAt: string }; author?: Family };
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

export async function requireProofs(home: string, identity: ProofIdentity, kinds: string[], author?: Family) {
  const recorded = await readOwed(home, identity);
  const owed = new Set(recorded?.kinds ?? []);
  for (const kind of kinds) owed.add(proofKind(kind));
  const sorted = proofKinds.filter((kind) => owed.has(kind));
  await writeJson(requiredPath(home, identity), { kinds: sorted, author: settleAuthor(recorded, author) } satisfies Owed);
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
  if (!author) throw new Error("The PR has no recorded author family. Run fleet proof require with --author claude|gpt, or from the author's session");
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
    throw new Error("This quotes the user's instructions in ~/.agents, not their answer to this question. A standing rule there is recorded once with fleet proof standing; otherwise ask the user and record their reply");
  }
}

export const retiredStandingKinds = ["review", "judge", "post-deploy-watch"];
const standingKinds = gapKinds.filter((kind) => !retiredStandingKinds.includes(kind));
export type StandingKind = GapKind;
type Standing = { kind: StandingKind; until: string; rule: string; recordedAt: string };
const standingPath = (home: string) => join(ledgerRoot(home), "standing.json");

function standingKind(value: string): StandingKind {
  if (retiredStandingKinds.includes(value)) throw new Error(`A standing rule no longer takes ${value}. Decide a review round with --agent '<your reason>', and a ${retiredStandingKinds.slice(1).join(" or ")} gap with fleet decision record --mark 🤖: both land in the decision ledger`);
  if (!(standingKinds as readonly string[]).includes(value)) throw new Error(`Unknown standing kind ${value}. Use one of ${standingKinds.join(", ")}`);
  return value as StandingKind;
}

export async function recordStanding(home: string, kinds: string, until: string, rule: string) {
  const covered = kinds.split(",").map((kind) => standingKind(kind.trim()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until))) throw new Error("--until needs a date such as 2026-11-02");
  const command = `fleet proof standing --kind ${kinds} --until ${until} --rule "${rule}"`;
  if (normalized(rule).length < minimumRule || !normalized(await agentInstructions(home)).includes(normalized(command))) {
    throw new Error(`The user's instructions in ~/.agents/AGENTS.md or ~/.agents/guides must hold this command word for word: ${command}. Only their own instructions set a standing rule, its kinds, and its date`);
  }
  const recordedAt = new Date().toISOString();
  const recorded = covered.map((kind): Standing => ({ kind, until, rule, recordedAt }));
  const others = (await listStanding(home)).filter((record) => !covered.includes(record.kind));
  await writeJson(standingPath(home), [...others, ...recorded]);
  return recorded;
}

export const listStanding = (home: string) => readJson<Standing[]>(standingPath(home), []);

export async function standingFor(home: string, kind: StandingKind, now: Date) {
  if (!standingKinds.includes(kind)) return undefined;
  const standing = (await listStanding(home)).find((record) => record.kind === kind);
  if (!standing) return undefined;
  const today = now.toISOString().slice(0, 10);
  const current = standingCommands(await agentInstructions(home)).filter((command) => command.kinds.includes(kind) && normalized(command.rule) === normalized(standing.rule));
  return current.some((command) => today < command.until && today < standing.until) ? standing : undefined;
}

function standingCommands(instructions: string) {
  const commands = instructions.replace(/\s+/g, " ").matchAll(/fleet proof standing --kind ([a-z,-]+) --until (\d{4}-\d{2}-\d{2}) --rule ["“]([^"”]*)["”]/g);
  return [...commands].map(([, kinds, until, rule]) => ({ kinds: kinds!.split(","), until: until!, rule: rule! }));
}

export async function judgeGap(home: string, identity: ProofIdentity, now: Date, decisions: Decisions, tier: Tier) {
  const gap = await readJson<Gap | undefined>(gapPath(home, identity, "judge"), undefined);
  if (gap?.commit !== identity.commit) return undefined;
  const weighed = await gapAcceptance({ home, identity, now, decisions, tier }, gap, "judge");
  return { reason: gap.reason, acceptance: weighed.acceptance, lapsed: weighed.lapsed, line: weighed.acceptance?.line ?? notAccepted(decisions, weighed), condition: weighed.condition };
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
type Weighed = { acceptance?: Acceptance; lapsed?: { id: string; reason: string }; condition?: Condition };

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
  const standing = kept || !Array.isArray(decisions) ? undefined : await standingFor(home, kind, now);
  return standing ? { acceptance: { by: "standing rule", line: `accepted by standing rule until ${standing.until}` } } : { lapsed };
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

async function entries(directory: string) {
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
  | { state: "ran"; commit: string; directory: string }
  | { state: "reused"; from: string; reason: string; directory: string }
  | { state: "carried"; from: string; merges: number; directory: string }
  | { state: "gap"; accepted: boolean; gap: GapProof }
  | { state: "missing"; newest?: string });
type KindState = KindProof extends infer P ? P extends KindProof ? Omit<P, "kind" | "line"> : never : never;

function kindLine(kind: ProofKind, proof: KindState) {
  switch (proof.state) {
    case "pending": return `${kind}: pending until the PR lands`;
    case "ran": return `${kind}: evidence at HEAD in ${proof.directory}`;
    case "reused": return `${kind}: evidence reused from ${short(proof.from)}: ${proof.reason}`;
    case "carried": return `${kind}: evidence of ${short(proof.from)} carried across ${proof.merges} clean merge(s) of the base`;
    case "gap": return `${kind}: ${gapText(proof.gap)}`;
    case "missing": return proof.newest
      ? `${kind}: missing at HEAD; the newest evidence is at ${short(proof.newest)}. Save new evidence, or run fleet proof save --kind ${kind} --reuse-from ${short(proof.newest)} --reason <why it still proves HEAD>`
      : `${kind}: missing`;
  }
}

const evidenceDirectory = (home: string, identity: ProofIdentity, kind: ProofKind, proof: Proved) => proof.directory ?? join(pullRequestDirectory(home, identity), proof.reuse!.from, kind);
const evidenceState = (identity: ProofIdentity, proof: Proved, directory: string): KindState =>
  proof.reuse ? { state: "reused", from: proof.reuse.from, reason: proof.reuse.reason, directory } : { state: "ran", commit: identity.commit, directory };

type KindStatus = Pick<Status, "problem" | "condition" | "lapsed"> & { proof: KindProof; evidence?: string };

const kindStatusOf = (kind: ProofKind, problem: Status["problem"], state: KindState, evidence?: string): KindStatus =>
  ({ problem, proof: { kind, line: kindLine(kind, state), ...state } as KindProof, evidence });

async function kindStatus(weigh: Weigh, kind: ProofKind, landed: boolean, cleanBaseMerge: CleanBaseMerge): Promise<KindStatus> {
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
  if (carried) { const directory = evidenceDirectory(home, identity, kind, proved.get(carried.from)!); return status(undefined, { state: "carried", from: carried.from, merges: carried.merges.length, directory }, directory); }
  if (gap) return { ...status(acceptance ? undefined : "gap", gapState()), ...countedGap(weighed) };
  const newest = [...proved].sort(([, a], [, b]) => (a.time < b.time ? 1 : -1))[0]?.[0];
  return { ...status("missing", newest ? { state: "missing", newest } : { state: "missing" }), ...lapseOf(weighed) };
}

type FinishedReview = { name: string; commit: string; reviewer?: string; finishedAt: bigint; panel: boolean };

async function finishedReviews(home: string, identity: ProofIdentity) {
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  const finished: FinishedReview[] = [];
  for (const name of await reviewNames(reviews)) {
    const reservation = await readJson<(ProofIdentity & { reviewer?: string }) | undefined>(join(reviews, name, "round.json"), undefined);
    const findings = await stat(join(reviews, name, "findings.md"), { bigint: true }).catch(() => undefined);
    const panel = await access(join(reviews, name, "panel.json")).then(() => true, () => false);
    if (reservation && findings) finished.push({ name, commit: reservation.commit, reviewer: reservation.reviewer, finishedAt: findings.mtimeNs, panel });
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
  let commit: string | undefined = start;
  while (commit && merges.length <= maxCarriedMerges && quiet.length <= maxQuietCommits) {
    if (reviewed.has(commit)) return { from: commit, merges, quiet, kinds: [...kinds] };
    const merged = cleanBaseMerge(commit);
    if (merged) { merges.push(commit); commit = merged; continue; }
    const step = quietCommit(commit);
    if (!step) return undefined;
    quiet.push(commit);
    step.kinds.forEach((kind) => kinds.add(kind));
    commit = step.parent;
  }
  return undefined;
}

async function carryForward(home: string, identity: ProofIdentity, reviewed: Set<string>, cleanBaseMerge: CleanBaseMerge, quietCommit: QuietCommit) {
  const found = reviewedThrough(identity.commit, reviewed, cleanBaseMerge, quietCommit);
  if (!found || (!found.merges.length && !found.quiet.length)) return undefined;
  const quiet = found.quiet.length ? { quiet: found.quiet, reason: quietReason(found.kinds) } : {};
  const carried: Carried = { commit: identity.commit, from: found.from, merges: found.merges, ...quiet, recordedAt: new Date().toISOString() };
  await writeJson(carriedPath(home, identity, identity.commit), carried);
  return carried;
}

const panelHint = "Run the qa-swarm panel with fleet proof review --lens <lens> --lens <lens> ..., or, for a PR that the user's rules exempt from the swarm, record fleet proof gap --kind panel --reason <the exception>";

async function reviewStatus(weigh: Weigh, cleanBaseMerge: CleanBaseMerge, quietCommit: QuietCommit): Promise<Status & { panelGap?: GapProof }> {
  const { home, identity, decisions } = weigh;
  const all = await finishedReviews(home, identity);
  const firstPanel = all.find((review) => review.panel);
  if (firstPanel) return headReview(home, identity, all.filter((review) => review.finishedAt >= firstPanel.finishedAt), cleanBaseMerge, quietCommit);
  const gap = await readJson<Gap | undefined>(gapPath(home, identity, "panel"), undefined);
  const weighed = await gapAcceptance(weigh, gap, "panel");
  const acceptance = weighed.acceptance;
  if (!gap && acceptance?.by !== "the user") return { problem: "missing", line: `review: no finished panel round on the PR${all.length ? `; ${all.length} single-reviewer review(s) do not count` : ""}. ${panelHint}`, ...lapseOf(weighed) };
  const panelGap = gapProof(gap, weighed, decisions);
  const line = `panel ${gapText(panelGap)}`;
  const head = await headReview(home, identity, all, cleanBaseMerge, quietCommit);
  if (!acceptance) return { problem: head.problem ?? "gap", line: `${head.line}; ${line}`, panelGap, ...countedGap(weighed) };
  return { ...head, line: `${head.line}; ${line}`, covered: head.covered && `${head.covered}, ${line}`, panelGap, ...countedGap(weighed) };
}

async function headReview(home: string, identity: ProofIdentity, finished: FinishedReview[], cleanBaseMerge: CleanBaseMerge, quietCommit: QuietCommit): Promise<Status> {
  const head = finished.filter((review) => review.commit === identity.commit).at(-1);
  if (head) {
    const covered = `${reviewLabel(head.name)}${head.reviewer ? ` by ${head.reviewer}` : ""}`;
    return { problem: undefined, line: `review: HEAD reviewed in ${covered}`, covered };
  }
  const carried = await carryForward(home, identity, new Set(finished.map((review) => review.commit)), cleanBaseMerge, quietCommit);
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

async function responseStatuses(home: string, identity: ProofIdentity): Promise<Status[]> {
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  const statuses = await Promise.all((await finishedReviews(home, identity)).map(async ({ name }): Promise<Status | undefined> => {
    const findings = await readFile(join(reviews, name, "findings.md"), "utf8");
    const missing = unanswered(findings, await readFile(join(reviews, name, "responses.md"), "utf8").catch(() => ""));
    return missing.length ? { problem: "missing", line: `review: ${reviewLabel(name)} has unanswered findings ${missing.join(", ")}; answer each with fleet proof respond --round ${name} <responses.md>` } : undefined;
  }));
  return statuses.filter((status) => status !== undefined);
}

export type CiResult = { state: "green" | "red" | "pending" | "none" | "unknown"; detail: string };

async function ciStatus(weigh: Weigh, ci: CiResult): Promise<Status & { gap?: GapProof }> {
  const { home, identity, decisions } = weigh;
  const line = `ci: ${ci.state}, ${ci.detail}`;
  if (ci.state === "green") return { problem: undefined, line, covered: "green" };
  const gap = await readJson<Gap | undefined>(gapPath(home, identity, "ci"), undefined);
  const weighed = await gapAcceptance({ ...weigh, ci }, gap, "ci");
  if (!gap && weighed.acceptance?.by !== "the user") return { problem: "missing", line: ci.state === "pending" ? line : `${line}. Fix it, or record fleet proof gap --kind ci --reason <why CI cannot run> when it cannot run here`, ...lapseOf(weighed) };
  const recorded = gapProof(gap, weighed, decisions);
  return { problem: weighed.acceptance ? undefined : "gap", line: `${line}; ${gapText(recorded)}`, covered: "gap accepted", gap: recorded, ...countedGap(weighed) };
}

export type PushedHead = { commit: string; body?: string } | { error: string };

function headStatus(identity: ProofIdentity, before: PushedHead, after: PushedHead): Status {
  if ("error" in before) return { problem: "missing", line: `head: cannot read the PR head on GitHub (${before.error})` };
  if (before.commit !== identity.commit) return { problem: "missing", line: `head: ${short(identity.commit)} is not the PR's head on GitHub (${short(before.commit) || "none"}); push it` };
  if ("error" in after) return { problem: "missing", line: `head: cannot read the PR head on GitHub again (${after.error})` };
  if (after.commit !== before.commit) return { problem: "missing", line: `head: the PR head moved to ${short(after.commit)} while the gate read CI; run the gate again` };
  return { problem: undefined, line: `head: ${short(identity.commit)} is the PR's head on GitHub` };
}

export type GateOptions = { ci: () => CiResult; pushedHead: () => PushedHead; ledger: Ledger; landed?: boolean; cleanBaseMerge?: CleanBaseMerge; quietCommit?: QuietCommit; now?: Date };

export type ProofSummary = {
  repository: string; pr: number; commit: string; tier: Tier; code: number;
  owed: { state: "unrecorded" | "none" | "owed"; kinds: ProofKind[]; reason?: string; line?: string };
  kinds: KindProof[];
  review: { state: "covered" | "missing" | "gap"; covered?: string; panelGap?: GapProof; unanswered: string[]; line: string };
  head: { state: "pushed" | "missing"; line: string };
  ci: { state: CiResult["state"]; detail: string; gap?: GapProof; line: string };
  judge: JudgeSummary;
  lapsed: string[]; lapsedLine?: string; voided: string[]; receipt?: string;
};

export type JudgeSummary = { state: "pass" | "fail" | "unavailable" | "not run" | "skipped"; model?: string; gap?: GapProof; lines: string[] };
export type CheckedSummary = Omit<ProofSummary, "judge">;

export const summaryLines = (summary: CheckedSummary) => [
  ...summary.owed.line ? [summary.owed.line] : [], ...summary.kinds.map((kind) => kind.line), summary.review.line, ...summary.review.unanswered,
  summary.head.line, summary.ci.line, ...summary.lapsedLine ? [summary.lapsedLine] : [],
];

const owedPart = (owed: Owed | undefined): CheckedSummary["owed"] =>
  !owed ? { state: "unrecorded", kinds: [], line: "owed proofs: not recorded; run fleet proof require --kinds <kind,kind> or fleet proof require --none --reason <why>" }
  : !owed.kinds.length ? { state: "none", kinds: [], ...owed.none ? { reason: owed.none.reason } : {}, line: `owed proofs: none (${owed.none?.reason ?? "no reason recorded"})` }
  : { state: "owed", kinds: owed.kinds };

const lapsedLine = (ids: string[]) => ids.length ? `lapsed: ${ids.map((id) => `🤖 decision ${id}`).join(", ")} no longer count${ids.length === 1 ? "s" : ""}; ask the user, or decide again once the reason is gone` : undefined;

export async function proofGate(home: string, identity: ProofIdentity, { ci, pushedHead, ledger, landed = false, cleanBaseMerge = () => undefined, quietCommit = () => undefined, now = new Date() }: GateOptions) {
  const before = pushedHead();
  const tier = "error" in before || before.body === undefined ? "ungraded" : tierOf(before.body);
  const decisions = await readDecisions(ledger);
  const weigh: Weigh = { home, identity, now, decisions, tier };
  const owed = await readOwed(home, identity);
  const kinds = await Promise.all((owed?.kinds ?? []).map((kind) => kindStatus(weigh, kind, landed, cleanBaseMerge)));
  const review = await reviewStatus(weigh, cleanBaseMerge, quietCommit);
  const responses = await responseStatuses(home, identity);
  const ciResult = ci();
  const head = headStatus(identity, before, pushedHead());
  const checks = await ciStatus(weigh, ciResult);
  const problems = [owed ? undefined : "missing", ...kinds.map((kind) => kind.problem), review.problem, ...responses.map((response) => response.problem), head.problem, checks.problem];
  const weighed = [...kinds, review, checks];
  const lapsed = [...new Set(weighed.flatMap((status) => status.problem && status.lapsed ? [status.lapsed] : []))];
  const conditions = weighed.flatMap((status) => status.condition ? [status.condition] : []);
  const code = problems.includes("missing") ? 1 : problems.includes("gap") ? 3 : 0;
  const voided = (Array.isArray(decisions) ? decisions : []).filter((decision) => decision.voided && covers(decision, identity)).map((decision) => decision.id);
  const receipt = (await readJson<{ url?: string } | undefined>(join(pullRequestDirectory(home, identity), "receipt.json"), undefined))?.url;
  const proofSummary: CheckedSummary = {
    repository: identity.repository, pr: identity.pr, commit: identity.commit, tier, code, owed: owedPart(owed), kinds: kinds.map((kind) => kind.proof),
    review: { state: review.problem ?? "covered", ...review.covered ? { covered: review.covered } : {}, ...review.panelGap ? { panelGap: review.panelGap } : {}, unanswered: responses.map((response) => response.line), line: review.line },
    head: { state: head.problem ? "missing" : "pushed", line: head.line },
    ci: { state: ciResult.state, detail: ciResult.detail, ...checks.gap ? { gap: checks.gap } : {}, line: checks.line },
    lapsed, ...lapsed.length ? { lapsedLine: lapsedLine(lapsed) } : {}, voided, ...receipt ? { receipt } : {},
  };
  const summary = `kinds: ${owed?.kinds.length ? owed.kinds.join(", ") : "none"}; review: ${review.covered}; CI: ${checks.covered}`;
  const evidence = kinds.map(({ proof, evidence }) => ({ kind: proof.kind, line: proof.line, directory: evidence }));
  return { code, lines: summaryLines(proofSummary), summary, owed, evidence, ci: ciResult, decisions, tier, conditions, voided, proofSummary };
}

export async function reviewRecords(home: string, identity: ProofIdentity) {
  const reviews = join(pullRequestDirectory(home, identity), "reviews");
  return Promise.all((await finishedReviews(home, identity)).map(async ({ name, commit, reviewer }) => {
    const reservation = await readJson<Reservation | undefined>(join(reviews, name, "round.json"), undefined);
    return {
      label: reviewLabel(name), commit, reviewer, capturedBy: reservation?.capturedBy ?? "author",
      findings: await readFile(join(reviews, name, "findings.md"), "utf8"),
      responses: await readFile(join(reviews, name, "responses.md"), "utf8").catch(() => undefined),
    };
  }));
}

export async function reviewOfCommit(home: string, identity: ProofIdentity) {
  const review = (await finishedReviews(home, identity)).filter((finished) => finished.commit === identity.commit).at(-1);
  if (!review) return undefined;
  const reservation = await readJson<Reservation | undefined>(join(pullRequestDirectory(home, identity), "reviews", review.name, "round.json"), undefined);
  return { label: reviewLabel(review.name), scope: reservation?.scope ?? "full", from: reservation?.from ?? reservation?.base, reviewer: review.reviewer };
}

export const judgeDirectory = (home: string, identity: ProofIdentity) => join(pullRequestDirectory(home, identity), "judge");
