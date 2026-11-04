import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { normalized, type Hear, type HeardAnswer } from "./proof-answers.ts";
import type { Family } from "./proof-models.ts";

export type ProofIdentity = { repository: string; pr: number; commit: string };
const sha = /^[0-9a-f]{40}$/;
export const ledgerRoot = (home: string) => join(home, ".local/state/fleet/proof");

function pullRequestDirectory(home: string, identity: ProofIdentity) {
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

export async function saveProof(home: string, identity: ProofIdentity, source: string, kind?: string): Promise<string> {
  const bytes = await readFile(source);
  if (!bytes.length) throw new Error(`${source} is empty. Save the output that shows the behavior`);
  const extension = extname(source).toLowerCase();
  if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw new Error("Proof files need a simple file extension");
  if (kind === "ui-walk" && !isScreenshot(source, bytes)) throw new Error("A UI walk keeps only screenshots of the running app");
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
  const reuse: Reuse = { from, reason, recordedAt: new Date().toISOString() };
  await writeJson(reusePath(home, identity, owed), reuse);
  return reuse;
}

const finalReadPrefix = "final-";
const isReviewName = (name: string) => /^(\d+|final-\d+)$/.test(name);
const reviewNames = async (reviews: string) => (await entries(reviews)).filter(isReviewName);
const reviewLabel = (name: string) => name.startsWith(finalReadPrefix) ? `final read ${name.slice(finalReadPrefix.length)}` : `round ${name}`;

export const proofKinds = ["live-run", "ui-walk", "prod-shape", "cross-version", "shadow-diff", "post-deploy-watch"] as const;
export type ProofKind = (typeof proofKinds)[number];
const gapKinds = [...proofKinds, "ci", "judge"] as const;
type GapKind = (typeof gapKinds)[number];

export function proofKind(value: string): ProofKind {
  if (!(proofKinds as readonly string[]).includes(value)) throw new Error(`Unknown proof kind ${value}. Use one of ${proofKinds.join(", ")}`);
  return value as ProofKind;
}

function gapKind(value: string): GapKind {
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

type Gap = { commit: string; reason: string; recordedAt: string; acceptance?: { instruction: string; acceptedAt: string; answer?: HeardAnswer } };
type GapUpdate = { reason: string } | { accept: string; hear: Hear };

const gapPath = (home: string, identity: ProofIdentity, kind: GapKind) => join(pullRequestDirectory(home, identity), "gaps", `${kind}.json`);

export async function recordGap(home: string, identity: ProofIdentity, kind: string, update: GapUpdate) {
  const path = gapPath(home, identity, gapKind(kind));
  if ("reason" in update) {
    if (!update.reason.trim()) throw new Error("A gap needs the reason the proof could not run");
    const gap: Gap = { commit: identity.commit, reason: update.reason, recordedAt: new Date().toISOString() };
    await writeJson(path, gap);
    return gap;
  }
  if (!update.accept.trim()) throw new Error("Accepting a gap needs the explicit user instruction");
  const gap = await readJson<Gap | undefined>(path, undefined);
  if (!gap) throw new Error(`No ${kind} gap is recorded. Record it with --reason first.`);
  await refuseBorrowedAnswer(home, identity, update.accept, "gap");
  const answer = await update.hear(update.accept);
  const accepted: Gap = { ...gap, acceptance: { instruction: update.accept, acceptedAt: new Date().toISOString(), answer } };
  await writeJson(path, accepted);
  return accepted;
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

type RecordedAnswer = { where: string; repository: string; pr: number; use: "round" | "gap"; text: string };

async function recordedAnswers(home: string) {
  const answers: RecordedAnswer[] = [];
  const root = ledgerRoot(home);
  for (const owner of await entries(root)) for (const name of await entries(join(root, owner))) for (const pr of await entries(join(root, owner, name))) {
    const [directory, repository] = [join(root, owner, name, pr), `${owner}/${name}`];
    for (const review of await reviewNames(join(directory, "reviews"))) {
      const override = (await readJson<{ override?: string } | undefined>(join(directory, "reviews", review, "round.json"), undefined))?.override;
      if (override) answers.push({ where: `${repository}#${pr} ${reviewLabel(review)}`, repository, pr: Number(pr), use: "round", text: override });
    }
    for (const file of (await entries(join(directory, "gaps"))).filter((entry) => entry.endsWith(".json"))) {
      const instruction = (await readJson<Gap | undefined>(join(directory, "gaps", file), undefined))?.acceptance?.instruction;
      if (instruction) answers.push({ where: `${repository}#${pr} ${file.slice(0, -5)} gap`, repository, pr: Number(pr), use: "gap", text: instruction });
    }
  }
  return answers;
}

async function refuseBorrowedAnswer(home: string, identity: ProofIdentity, text: string, use: "round" | "gap") {
  const answer = normalized(text);
  if (instructionSentences(await agentInstructions(home)).some((sentence) => answer.includes(sentence))) {
    throw new Error("This quotes the user's instructions in ~/.agents, not their answer to this question. A standing rule there is recorded once with fleet proof standing; otherwise ask the user and record their reply");
  }
  const samePrGaps = (recorded: RecordedAnswer) => use === "gap" && recorded.use === "gap" && recorded.repository === identity.repository && recorded.pr === identity.pr;
  const borrowed = (await recordedAnswers(home)).find((recorded) => normalized(recorded.text) === answer && !samePrGaps(recorded));
  if (borrowed) throw new Error(`This answer is already recorded on ${borrowed.where}. Each round, and the gaps of each PR, need the user's answer to that question; quote it with what it answers`);
}

const standingKinds = [...gapKinds, "review"] as const;
export type StandingKind = (typeof standingKinds)[number];
type Standing = { kind: StandingKind; until: string; rule: string; recordedAt: string };
const standingPath = (home: string) => join(ledgerRoot(home), "standing.json");

function standingKind(value: string): StandingKind {
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
  const standing = (await listStanding(home)).find((record) => record.kind === kind);
  if (!standing || now.toISOString().slice(0, 10) >= standing.until) return undefined;
  return normalized(await agentInstructions(home)).includes(normalized(standing.rule)) ? standing : undefined;
}

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
