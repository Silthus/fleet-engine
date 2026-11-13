import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { optionalStringSetting } from "../../base/lib/settings.ts";
import { normalized, t3ThreadWords, type HeardAnswer, type ThreadWord, type ThreadWords } from "./proof-answers.ts";
import { readPullRequest, restJson, runIn } from "./pr-ci.ts";
import { gapKind, refuseInstructionQuote, usedAnswer } from "./proof.ts";

export const askClasses = ["proof-gap", "review", "merge", "deploy", "secret", "design", "scope", "status"] as const;
export type AskClass = (typeof askClasses)[number];
export const marks = ["👤", "👍", "🤖"] as const;
export type Mark = (typeof marks)[number];
type UsersMark = "👤" | "👍";
export type Effect = "accept" | "keep-owed";

export type Decision = {
  id: string; at: string; class: AskClass; mark: Mark; question: string; answer: string;
  rejected?: string; reason?: string;
  scope: { prs: string[]; kinds?: string[]; condition?: string };
  effect?: Effect;
  where: { thread: string; message?: string; machine: string; link?: string };
};
export type Reversal = { type: "reverse"; id: string; words: string; thread?: string; message?: string; comment?: string; machine: string; at: string };
export type Lift = { type: "lift"; class: AskClass; words: string; thread: string; message: string; machine: string; at: string };
export type LedgerEvent =
  | { type: "decide"; decision: Decision }
  | { type: "void"; id: string; reason: string; at: string }
  | Reversal
  | Lift;

export class HubUnreachable extends Error {}

export type Ledger = { read(): Promise<LedgerEvent[]>; append(...events: LedgerEvent[]): Promise<void> };
const lines = (events: LedgerEvent[]) => events.map((event) => JSON.stringify(event) + "\n").join("");

const relativePath = ".local/state/fleet/decisions.jsonl";
export const ledgerPath = (home: string) => join(home, relativePath);

const isText = (value: unknown): value is string => typeof value === "string";
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
const isRef = (value: string) => refPattern.test(value);
const isFilled = (value: unknown): value is string => isText(value) && value.trim() !== "";
const isTime = (value: unknown): value is string => isText(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));

type RawEvent = { type?: unknown; id?: unknown; class?: unknown; reason?: unknown; words?: unknown; at?: unknown; thread?: unknown; message?: unknown; comment?: unknown; decision?: Partial<Record<keyof Decision, unknown>> } | null;
const inThread = (event: NonNullable<RawEvent>) => isFilled(event.words) && isTime(event.at) && isFilled(event.thread) && isFilled(event.message);
const heardEvent = (event: NonNullable<RawEvent>) => inThread(event) || (isFilled(event.words) && isTime(event.at) && isFilled(event.comment));

function validEvent(value: unknown): value is LedgerEvent {
  const event = value as RawEvent;
  if (event?.type === "void") return isText(event.id) && isText(event.reason);
  if (event?.type === "reverse") return isFilled(event.id) && heardEvent(event);
  if (event?.type === "lift") return (askClasses as readonly unknown[]).includes(event.class) && inThread(event);
  const decision = event?.type === "decide" ? event.decision : undefined;
  if (!decision || !isText(decision.id) || !isText(decision.at) || !isText(decision.question) || !isText(decision.answer)) return false;
  if (!(askClasses as readonly unknown[]).includes(decision.class) || !(marks as readonly unknown[]).includes(decision.mark)) return false;
  if (decision.effect !== undefined && decision.effect !== "accept" && decision.effect !== "keep-owed") return false;
  const scope = decision.scope as Decision["scope"] | undefined;
  const where = decision.where as Decision["where"] | undefined;
  return isTexts(scope?.prs) && scope.prs.length > 0 && scope.prs.every(isRef) && (scope.kinds === undefined || isTexts(scope.kinds)) && isText(where?.thread);
}

function parseEvents(text: string): LedgerEvent[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const event: unknown = JSON.parse(line);
      return validEvent(event) ? [event] : [];
    } catch { return []; }
  });
}

export function localLedger(home: string): Ledger {
  const path = ledgerPath(home);
  return {
    read: async () => {
      try { return parseEvents(await readFile(path, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    },
    append: async (...events) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await appendFile(path, lines(events), { mode: 0o600 });
    },
  };
}

export type SshResult = { code: number; stdout: string; stderr: string };
export type Ssh = (host: string, command: string, stdin?: string) => Promise<SshResult>;

const remoteFile = `"$HOME/${relativePath}"`;

function sshLedger(hub: string, ssh: Ssh): Ledger {
  const unreachable = ({ stderr }: SshResult) => new HubUnreachable(`hub ${hub} unreachable over SSH${stderr.trim() ? ` (${stderr.trim().split("\n").at(-1)})` : ""}`);
  return {
    read: async () => {
      const result = await ssh(hub, `f=${remoteFile}; [ ! -e "$f" ] || cat "$f"`);
      if (result.code !== 0) throw unreachable(result);
      return parseEvents(result.stdout);
    },
    append: async (...events) => {
      const result = await ssh(hub, `umask 077 && f=${remoteFile} && mkdir -p "$(dirname "$f")" && t=$(mktemp "$f.XXXXXX") && cat > "$t" && cat "$t" >> "$f"; s=$?; rm -f "$t"; exit $s`, lines(events));
      if (result.code !== 0) throw unreachable(result);
    },
  };
}

const runSsh: Ssh = async (host, command, stdin) => {
  const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code: code ?? 255, stdout, stderr };
};

type Env = Record<string, string | undefined>;

function isHub(home: string) {
  try { return (JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8")) as { role?: unknown }).role === "hub"; }
  catch { return false; }
}

export function hubLedger(home: string, env: Env, ssh: Ssh = runSsh): Ledger {
  const hub = optionalStringSetting("hub.alias", env);
  return hub && !isHub(home) ? sshLedger(hub, ssh) : localLedger(home);
}

export const thisMachine = (env: Env) => env.CODER_WORKSPACE_NAME || hostname();

export type DecisionState = Decision & { voided?: { reason: string; at: string }; reversed?: { at: string; mark: Mark; answer: string; rejected?: string } };

const messageKey = ({ thread, message }: Decision["where"]) => message && `${thread}/${message}`;

export const brakeDays = 28;
const dayMs = 24 * 60 * 60 * 1000;
export type Brake = { ids: [string, string]; at: string };

function replay(events: LedgerEvent[]) {
  const decisions = new Map<string, DecisionState>();
  const messages = new Set<string>();
  const reversals = new Map<AskClass, { id: string; time: number }[]>();
  const brakes = new Map<AskClass, Brake>();
  for (const event of events) {
    if (event.type === "decide") {
      const { id, mark, class: decisionClass } = event.decision;
      const message = messageKey(event.decision.where);
      if (decisions.has(id) || (message && messages.has(message)) || (mark === "🤖" && brakes.has(decisionClass))) continue;
      if (message) messages.add(message);
      decisions.set(id, { ...event.decision });
    } else if (event.type === "void") {
      const decision = decisions.get(event.id);
      if (decision && !decision.reversed) decision.voided = { reason: event.reason, at: event.at };
    } else if (event.type === "lift") {
      reversals.delete(event.class);
      brakes.delete(event.class);
    } else {
      const decision = decisions.get(event.id);
      if (!decision || decision.reversed) continue;
      const { rejected, ...rest } = decision;
      decisions.set(event.id, { ...rest, mark: "👤", answer: event.words, reversed: { at: event.at, mark: decision.mark, answer: decision.answer, ...rejected ? { rejected } : {} } });
      const time = Date.parse(event.at);
      const earlier = reversals.get(decision.class) ?? [];
      const close = earlier.find((other) => Math.abs(time - other.time) <= brakeDays * dayMs);
      if (close && !brakes.has(decision.class)) brakes.set(decision.class, { ids: [close.id, event.id], at: event.at });
      reversals.set(decision.class, [...earlier, { id: event.id, time }]);
    }
  }
  return { decisions: [...decisions.values()], brakes };
}

export const fold = (events: LedgerEvent[]): DecisionState[] => replay(events).decisions;
export const brakeOf = (events: LedgerEvent[], decisionClass: AskClass): Brake | undefined => replay(events).brakes.get(decisionClass);

export type PrRef = { repository: string; pr: number };
const refPattern = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/;

export function prRef(value: string): PrRef {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:pull|issues)\/([1-9]\d*)\/?$/.exec(value) ?? refPattern.exec(value);
  if (!match) throw new Error(`--pr takes owner/repo#number or a PR URL, not ${value}`);
  return { repository: match[1]!, pr: Number(match[2]) };
}

export const refText = ({ repository, pr }: PrRef) => `${repository}#${pr}`;
const sameRef = (a: PrRef, b: PrRef) => a.repository.toLowerCase() === b.repository.toLowerCase() && a.pr === b.pr;
export const covers = (decision: Decision, ref: PrRef) => decision.scope.prs.some((text) => sameRef(prRef(text), ref));

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function namesPr(question: string, { repository, pr }: PrRef) {
  const [owner, repo] = repository.split("/").map(escape) as [string, string];
  const patterns = [
    `(?<![\\w./-])(?:(?:${owner}/)?${repo})?#${pr}(?!\\d)`,
    `(?<![\\w./-])(?:https?://)?(?:www\\.)?github\\.com/${owner}/${repo}/(?:pull|issues)/${pr}(?!\\d)`,
  ];
  return patterns.some((pattern) => new RegExp(pattern, "i").test(question));
}

const who = (mark: Mark) => mark === "🤖" ? "agent" : "the user";

const rejectedText = (rejected: string | undefined) => rejected ? ` Rejected: ${rejected}.` : "";

export function decisionLine(decision: DecisionState) {
  const { reversed } = decision;
  const replaced = reversed ? ` (reversed ${reversed.at.slice(0, 10)} from ~~${reversed.mark} ${reversed.answer}${rejectedText(reversed.rejected)}~~)` : "";
  const state = decision.voided ? ` voided: ${decision.voided.reason}` : "";
  return `- ${decision.mark} **${decision.question}** ${decision.answer}${rejectedText(decision.rejected)}${replaced} (${who(decision.mark)}, ${decision.class}, thread ${decision.where.thread}) [${decision.id}]${state}`;
}

export const live = (decision: DecisionState) => !decision.voided && !decision.reversed;
const isUsers = (decision: Decision) => decision.mark === "👤" || decision.mark === "👍";
const gapDecision = (decision: DecisionState, ref: PrRef, kind: string, effect: Effect) =>
  live(decision) && decision.class === "proof-gap" && decision.effect === effect && decision.scope.kinds?.includes(kind) && covers(decision, ref);

export function usersAcceptance(decisions: DecisionState[], ref: PrRef, kind: string) {
  return decisions.findLast((decision) => isUsers(decision) && gapDecision(decision, ref, kind, "accept"));
}

export function agentsAcceptance(decisions: DecisionState[], ref: PrRef, kind: string) {
  return decisions.findLast((decision) => decision.mark === "🤖" && gapDecision(decision, ref, kind, "accept"));
}

export function keptOwed(decisions: DecisionState[], ref: PrRef, kind: string) {
  return decisions.findLast((decision) => isUsers(decision) && gapDecision(decision, ref, kind, "keep-owed"));
}

export type Tier = "critical" | "non-critical" | "ungraded";

export function tierOf(body: string): Tier {
  const callout = /<!--\s*merge-risk\s*-->([\s\S]*?)<!--\s*\/merge-risk\s*-->/.exec(body)?.[1];
  const line = callout && /^[\s>*-]*\**Tier\**:\**\s*\**\s*(non-critical|critical)\b/im.exec(callout);
  return line ? line[1]!.toLowerCase() as Tier : "ungraded";
}

export const processGapKinds = ["judge", "post-deploy-watch"];
const processClasses: AskClass[] = ["review", "status"];
export const panelRefusal = "a panel gap is the user's to accept";

export function agentRefusal(tier: Tier, decisionClass: AskClass, kinds: string[] = []) {
  if (decisionClass === "proof-gap" && kinds.includes("panel")) return "panel";
  if (tier === "ungraded") return "ungraded";
  const process = processClasses.includes(decisionClass) || (decisionClass === "proof-gap" && kinds.length > 0 && kinds.every((kind) => processGapKinds.includes(kind)));
  return tier === "critical" && !process ? "critical head" : undefined;
}

export type DecisionContext = {
  home: string; cwd: string; env: Env; print: (text: string) => void; now?: () => Date;
  threadWords?: ThreadWords; ssh?: Ssh; ledger?: Ledger; pullBody?: (ref: PrRef) => Promise<string>; pendingCard?: (thread: string) => Promise<boolean>;
};

const usage = `Usage:
  fleet decision record --mark 👤|👍 --class <class> --pr <owner/repo#n>... [--kind <kind>...] [--thread <id>] [--message <id> | --words '<date> "<the user's words>"'] [--condition <text>] [--keep-owed]
  fleet decision record --mark 🤖 --class <class> --pr <owner/repo#n>... --question <q> --answer <a> --rejected <option> --reason <why> [--kind <kind>...] [--condition <text>] [--thread <id>] [--link <side-fix thread>]
  fleet decision list [--pr <owner/repo#n>] [--class <class>] [--live]
  fleet decision void <id> --reason <why its condition no longer holds>
  fleet decision reverse <id> --words '<date> "<the user's words>"' (--thread <id> | --comment <url>)
  fleet decision lift --class <class> --words '<date> "<the user's answer>"' --thread <id>
  fleet decision report --pr <owner/repo#n>... [--thread <id>]

The decision ledger holds every decision about a pull request's proof and process. It lives on the Fleet hub that
the setting hub.alias names; other machines read and append it over SSH. Without a hub, it lives on this machine.

record with 👤 or 👍 records the user's answer to your question tool. Without --words it takes their latest answer
in the T3 thread whose question names each --pr: after they answer, pass only the mark, class, kinds and PRs, and
check the answer in the printed line. --message takes an earlier answer by its id. --words quotes the words of an
answer, with the date they gave it. --thread defaults to this T3 thread (T3CODE_THREAD_ID). Only answers to a
question tool in the T3 app count; a typed message does not. Each --pr must be named in that question (#n,
repo#n, owner/repo#n, or its URL), so one answer covers every PR its question named and no other. One answer
records one decision. With --class proof-gap and --kind, the decision accepts those gaps of each PR, and the user's
choice must start with "Accept" or "Yes"; with --keep-owed, it keeps them owed whatever an agent decides. --condition names
what must stay true at HEAD; the judge checks it. Classes: ${askClasses.join(", ")}.
record with 🤖 records the agent's own decision with the option it rejected. Fleet reads each PR's Tier line in its
merge-risk callout at HEAD: it refuses an ungraded PR, and on a critical PR anything but process (review and status
asks, judge and post-deploy-watch gaps). It never takes a panel gap: ${panelRefusal}. The gate never counts a 🤖 ci
acceptance over CI that ran, nor one under the user's keep-owed, and prints each 🤖 acceptance that lapsed.
list prints the decisions as decision lines with their ids. Run it before you ask.
void ends a decision whose condition HEAD no longer meets, such as when the judge fails it; then decide or ask again.
reverse records the user's reversal of a decision: their dated, quoted words in a message of theirs in the T3 thread,
or on a GitHub comment written by the account gh is signed in as, which must hold each quoted part. The decision then
prints as 👤 with their words, the replaced answer struck through, and counts no more at the gate or in list --live;
decide or ask again. Two reversals in one class within ${brakeDays} days brake the class: record --mark 🤖 and fleet proof
review --agent in it are refused until lift records the user's answer to your question tool, given after the brake.
One answer lifts one brake. A 🤖 decision that lands while its class is braked counts nowhere.
record --mark 🤖 --class scope takes --link with the T3 thread a side fix started in.
report prints the lane's end-of-run report in Markdown, in five sections: still yours (unaccepted gaps on critical
heads first, a question card that waits in --thread, then open PRs whose proofs pass and wait on the user's merge
word), PRs merged under the narrow grant (merged lines of the rollout log that orchestration.rolloutLog names, whose
note names the narrow grant), the lane's decisions sorted 👤 👍 🤖, one proofs row per PR from its proof summary at
its HEAD on GitHub with its receipt link, and the side fixes the lane started. --thread defaults to this T3 thread.
Send it as the lane's final message, and post it once on the lane's ticket or bottom PR.`;

type Parsed = { options: Map<string, string>; lists: Map<string, string[]>; flags: Set<string>; positional: string[] };

function parse(args: string[], valued: string[], repeatable: string[], flagNames: string[]): Parsed {
  const parsed: Parsed = { options: new Map(), lists: new Map(), flags: new Set(), positional: [] };
  while (args.length) {
    const arg = args.shift()!;
    if (flagNames.includes(arg)) { parsed.flags.add(arg); continue; }
    if (!arg.startsWith("--")) { parsed.positional.push(arg); continue; }
    if (!valued.includes(arg) && !repeatable.includes(arg)) throw new Error(`Unknown option ${arg}. Run fleet decision --help`);
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value. Run fleet decision --help`);
    if (repeatable.includes(arg)) parsed.lists.set(arg, [...parsed.lists.get(arg) ?? [], value]);
    else parsed.options.set(arg, value);
  }
  return parsed;
}

function required(parsed: Parsed, option: string) {
  const value = parsed.options.get(option);
  if (value === undefined || !value.trim()) throw new Error(`${option} is required. Run fleet decision --help`);
  return value;
}

export function askClass(value: string): AskClass {
  if (!(askClasses as readonly string[]).includes(value)) throw new Error(`Unknown class ${value}. Use one of ${askClasses.join(", ")}`);
  return value as AskClass;
}

async function reachHub<T>(step: () => Promise<T>) {
  try { return await step(); }
  catch (error) {
    if (!(error instanceof HubUnreachable)) throw error;
    throw new Error(`Not recorded: ${error.message}. Run the same command again once the hub is back`);
  }
}

const newId = () => `d-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
const at = (context: DecisionContext) => (context.now?.() ?? new Date()).toISOString();
const alreadyRecorded = (id: string) => new Error(`That answer is already recorded as decision ${id}. One answer records one decision; it covers the PRs its question named. Ask the user again`);
const recordedFor = async (ledger: Ledger, where: Decision["where"]) => fold(await reachHub(() => ledger.read())).find((decision) => messageKey(decision.where) === messageKey(where));

export type Scope = { class: AskClass; prs: PrRef[]; kinds?: string[]; condition?: string };
const scopeOf = ({ prs, kinds, condition }: Scope): Decision["scope"] => ({ prs: prs.map(refText), ...kinds?.length ? { kinds } : {}, ...condition ? { condition } : {} });

function checkScope({ class: decisionClass, prs, kinds }: Scope) {
  if (!prs.length) throw new Error("--pr is required. Run fleet decision --help");
  if (decisionClass === "proof-gap" && !kinds?.length) throw new Error("A proof-gap decision needs --kind with each gap kind it decides");
  if (decisionClass !== "proof-gap" && kinds?.length) throw new Error("--kind and --keep-owed belong to --class proof-gap");
  kinds?.forEach(gapKind);
}

const quotes = (text: string) => [...text.matchAll(/["“]([^"”]*)["”]/g)].map((match) => normalized(match[1]!)).filter(Boolean);
const isDatedQuote = (text: string) => /\b\d{4}-\d{2}-\d{2}\b/.test(text) && quotes(text).length > 0;

export type Hearing = Scope & { mark: UsersMark; thread?: string; words?: string; message?: string; keepOwed?: boolean; fits?: (answer: HeardAnswer) => void };

export async function hearUser(input: Hearing, context: DecisionContext, ledger: Ledger): Promise<Decision> {
  checkScope(input);
  const thread = input.thread ?? context.env.T3CODE_THREAD_ID;
  if (!thread) throw new Error("The user's answer needs --thread with the id of the T3 thread where they gave it. A conductor may pass its own thread id");
  if (input.words !== undefined && input.message !== undefined) throw new Error("Pass --message or --words, not both");
  if (input.words !== undefined) await refuseInstructionQuote(context.home, input.words);
  const answers = await (context.threadWords ?? t3ThreadWords(context.home))(thread);
  const refusals: Error[] = [];
  let used: Error | undefined;
  for (const word of candidates(answers, input, thread)) {
    const heard = heardAnswer(word);
    try {
      fits(heard, input);
      const where = { thread: word.thread, message: word.id, machine: thisMachine(context.env) };
      const earlier = await recordedFor(ledger, where);
      if (earlier) { used ??= alreadyRecorded(earlier.id); continue; }
      const usedOn = await usedAnswer(context.home, heard);
      if (usedOn) { used ??= new Error(usedOn); continue; }
      return {
        id: newId(), at: at(context), class: input.class, mark: input.mark, question: word.answered, answer: `${word.at.slice(0, 10)} "${word.text}"`, scope: scopeOf(input),
        ...input.class === "proof-gap" ? { effect: input.keepOwed ? "keep-owed" as const : "accept" as const } : {}, where,
      };
    } catch (error) { refusals.push(error as Error); }
  }
  throw used ?? refusals[0]!;
}

const heardAnswer = (word: ThreadWord): HeardAnswer => ({ thread: word.thread, message: word.id, words: word.text, answered: word.answered, at: word.at, source: word.source });

function candidates(answers: ThreadWord[], { words, message, prs }: Hearing, thread: string): ThreadWord[] {
  if (message !== undefined) {
    const named = answers.filter((word) => word.id === message);
    if (!named.length) throw new Error(`No message of the user's in thread ${thread} has the id ${message}`);
    return named;
  }
  if (words !== undefined) {
    if (!isDatedQuote(words)) throw new Error(`Quote the user's answer with the date they gave it, such as '2026-10-24 "Accept the gap"'`);
    const said = answers.filter((word) => normalized(word.text) === quotes(words).join(" ")).reverse();
    if (!said.length) throw new Error(`"${quotes(words).join('" … "')}" is not in a message of the user's in thread ${thread}. Quote their whole answer, so a refusal such as "Do not accept the gap." never reads as an acceptance. Only their answer to a question tool in the T3 app counts`);
    return said;
  }
  const latest = answers.findLast((word) => word.source === "question" && prs.every((ref) => namesPr(word.answered, ref)));
  if (!latest) throw new Error(`No answer of the user's to a question tool in thread ${thread} names ${prs.map(refText).join(", ")}. Ask them with the question tool and name each PR in the question. Only answers they gave in the T3 app count`);
  return [latest];
}

function fits(heard: HeardAnswer, input: Hearing) {
  input.fits?.(heard);
  if (heard.source !== "question") throw new Error(`"${heard.words}" is a message the user typed. Only their answer to your question tool counts: ask them with it and name each PR in the question`);
  const unnamed = input.prs.filter((ref) => !namesPr(heard.answered, ref));
  if (unnamed.length) throw new Error(`The question the user answered does not name ${unnamed.map(refText).join(", ")}. An answer covers only the PRs its question named; ask them about the others. The question: ${heard.answered}`);
  const unnamedKinds = (input.kinds ?? []).filter((kind) => !new RegExp(`(?<![\\w-])${escape(kind)}(?![\\w-])`, "i").test(heard.answered));
  if (unnamedKinds.length) throw new Error(`The question the user answered does not name the ${unnamedKinds.join(", ")} gap. Ask them about each gap kind by name. The question: ${heard.answered}`);
  if (input.class === "proof-gap" && !input.keepOwed && !acceptsGap(heard.words)) throw new Error(`The user chose "${heard.words}", which does not accept the gap. The gap stays open`);
}

export async function appendDecision(ledger: Ledger, decision: Decision) {
  await reachHub(() => ledger.append({ type: "decide", decision }));
  if (!decision.where.message && decision.mark !== "🤖") return decision.id;
  const decisions = fold(await reachHub(() => ledger.read()));
  if (decision.mark === "🤖" && !decisions.some((candidate) => candidate.id === decision.id)) {
    throw new Error(`The ${decision.class} class was braked while this decision was recorded, so it counts nowhere. An agent decides no ${decision.class} ask alone until the user lifts the brake; ask them`);
  }
  const winner = decision.where.message ? decisions.find((candidate) => messageKey(candidate.where) === messageKey(decision.where)) : undefined;
  if (winner && winner.id !== decision.id) throw alreadyRecorded(winner.id);
  return decision.id;
}

const prsOf = (parsed: Parsed) => (parsed.lists.get("--pr") ?? []).map(prRef);

export type AgentDecision = Scope & { question: string; answer: string; rejected: string; reason: string; thread?: string; link?: string };

export async function decideAlone(input: AgentDecision, context: DecisionContext, ledger: Ledger): Promise<Decision> {
  checkScope(input);
  for (const [name, value] of Object.entries({ "--question": input.question, "--answer": input.answer, "--rejected": input.rejected, "--reason": input.reason })) {
    if (!value.trim()) throw new Error(`An agent decision needs ${name}`);
  }
  const thread = input.thread ?? context.env.T3CODE_THREAD_ID;
  if (!thread) throw new Error("An agent decision needs --thread with this lane's T3 thread id");
  if (input.link !== undefined && input.class !== "scope") throw new Error("--link belongs to a scope decision: the T3 thread its side fix started in");
  const brake = brakeOf(await reachHub(() => ledger.read()), input.class);
  if (brake) throw new Error(`The ${input.class} class is braked: the user reversed decisions ${brake.ids[0]} and ${brake.ids[1]} within ${brakeDays} days. An agent decides no ${input.class} ask alone until the user lifts it with fleet decision lift; ask them`);
  if (agentRefusal("non-critical", input.class, input.kinds) === "panel") throw new Error(`${input.prs.map(refText).join(", ")}: ${panelRefusal}. Ask them with your question tool and record their answer with --mark 👤`);
  const pullBody = pullBodyOf(context);
  for (const ref of input.prs) {
    const refusal = agentRefusal(tierOf(await pullBody(ref).catch(() => "")), input.class, input.kinds);
    if (refusal === "ungraded") throw new Error(`${refText(ref)} is ungraded: its merge-risk callout has no Tier line at HEAD. An agent never decides alone on an ungraded PR; grade it with merge-risk, or ask the user`);
    if (refusal) throw new Error(`${refText(ref)} is critical at HEAD: an agent decides only process there (review and status asks, judge and post-deploy-watch gaps). Ask the user`);
  }
  return {
    id: newId(), at: at(context), class: input.class, mark: "🤖", question: input.question, answer: input.answer,
    rejected: input.rejected, reason: input.reason, scope: scopeOf(input), ...input.class === "proof-gap" ? { effect: "accept" as const } : {},
    where: { thread, machine: thisMachine(context.env), ...input.link ? { link: input.link } : {} },
  };
}

async function record(parsed: Parsed, context: DecisionContext, ledger: Ledger) {
  const mark = required(parsed, "--mark");
  const scope: Scope = { class: askClass(required(parsed, "--class")), prs: prsOf(parsed), kinds: parsed.lists.get("--kind"), condition: parsed.options.get("--condition") };
  const keepOwed = parsed.flags.has("--keep-owed");
  if (keepOwed && scope.class !== "proof-gap") throw new Error("--kind and --keep-owed belong to --class proof-gap");
  let decision: Decision;
  if (mark === "🤖") {
    if (parsed.options.has("--words") || parsed.options.has("--message") || keepOwed) throw new Error("--words, --message and --keep-owed are the user's: an agent decision takes --question, --answer, --rejected and --reason");
    decision = await decideAlone({ ...scope, question: required(parsed, "--question"), answer: required(parsed, "--answer"), rejected: required(parsed, "--rejected"), reason: required(parsed, "--reason"), thread: parsed.options.get("--thread"), link: parsed.options.get("--link") }, context, ledger);
  } else if (mark === "👤" || mark === "👍") {
    for (const option of ["--question", "--answer", "--rejected", "--reason", "--link"]) if (parsed.options.has(option)) throw new Error(`${option} belongs to the agent's own decision. The user's decision takes its question and answer from T3`);
    decision = await hearUser({ ...scope, mark, keepOwed, thread: parsed.options.get("--thread"), words: parsed.options.get("--words"), message: parsed.options.get("--message") }, context, ledger);
  } else throw new Error("--mark takes 👤 (the user's own answer), 👍 (they accepted the recommended default) or 🤖 (the agent's own decision)");
  await appendDecision(ledger, decision);
  context.print(decisionLine(decision));
  return 0;
}

async function voidDecision(parsed: Parsed, context: DecisionContext, ledger: Ledger) {
  const [id, ...rest] = parsed.positional;
  if (!id || rest.length) throw new Error("Name one decision id. Run fleet decision --help");
  const reason = required(parsed, "--reason");
  const decision = fold(await reachHub(() => ledger.read())).find((candidate) => candidate.id === id);
  if (!decision) throw new Error(`No decision ${id} in the ledger. Run fleet decision list`);
  if (decision.voided) throw new Error(`Decision ${id} is already voided: ${decision.voided.reason}`);
  const voidedAt = at(context);
  await reachHub(() => ledger.append({ type: "void", id, reason, at: voidedAt }));
  context.print(decisionLine({ ...decision, voided: { reason, at: voidedAt } }));
  return 0;
}

const commentPattern = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/[1-9]\d*#issuecomment-(\d+)$/;
const quoteWithDate = new Error(`Quote the user's words with the date they wrote them, such as '2026-10-24 "Reverse that."'`);

async function heardInThread(thread: string, words: string, context: DecisionContext) {
  if (!isDatedQuote(words)) throw quoteWithDate;
  await refuseInstructionQuote(context.home, words);
  const said = (await (context.threadWords ?? t3ThreadWords(context.home))(thread)).filter((word) => normalized(word.text) === quotes(words).join(" "));
  const word = said.at(-1);
  if (!word) throw new Error(`"${quotes(words).join('" … "')}" is not in a message of the user's in thread ${thread}. Quote their whole message`);
  return word;
}

async function heardOnComment(url: string, words: string, context: DecisionContext) {
  const [, repository, id] = commentPattern.exec(url) ?? [];
  if (!repository || !id) throw new Error(`--comment takes the URL of a GitHub issue or PR comment, such as https://github.com/owner/repo/issues/1#issuecomment-2, not ${url}`);
  if (!isDatedQuote(words)) throw quoteWithDate;
  const run = runIn(context.cwd, context.env);
  const login = restJson<{ login: string }>("user", run).login;
  const comment = restJson<{ user?: { login?: string }; body?: string }>(`repos/${repository}/issues/comments/${id}`, run);
  const author = comment.user?.login ?? "";
  if (author.toLowerCase() !== login.toLowerCase()) throw new Error(`The comment is by ${author || "nobody"}, not the user (${login}). Only the user's own words reverse a decision`);
  const body = normalized(comment.body ?? "");
  const missing = quotes(words).find((quote) => !body.includes(quote));
  if (missing) throw new Error(`"${missing}" is not in the comment ${url}. Quote the user's words as they wrote them`);
}

async function reverse(parsed: Parsed, context: DecisionContext, ledger: Ledger) {
  const [id, ...rest] = parsed.positional;
  if (!id || rest.length) throw new Error("Name one decision id. Run fleet decision --help");
  const words = required(parsed, "--words");
  const thread = parsed.options.get("--thread");
  const comment = parsed.options.get("--comment");
  if ((thread === undefined) === (comment === undefined)) throw new Error("Pass --thread with the T3 thread where the user reversed it, or --comment with the GitHub comment where they did. Run fleet decision --help");
  const events = await reachHub(() => ledger.read());
  const decision = fold(events).find((candidate) => candidate.id === id);
  if (!decision) throw new Error(`No decision ${id} in the ledger. Run fleet decision list`);
  if (decision.reversed) throw new Error(`Decision ${id} is already reversed, on ${decision.reversed.at.slice(0, 10)}`);
  const where = thread !== undefined ? { thread, message: (await heardInThread(thread, words, context)).id } : (await heardOnComment(comment!, words, context), { comment: comment! });
  const event: Reversal = { type: "reverse", id, words, ...where, machine: thisMachine(context.env), at: at(context) };
  await reachHub(() => ledger.append(event, { type: "void", id, reason: `reversed by the user: ${words}`, at: event.at }));
  context.print(decisionLine(fold([...events, event]).find((candidate) => candidate.id === id)!));
  return 0;
}

async function lift(parsed: Parsed, context: DecisionContext, ledger: Ledger) {
  const decisionClass = askClass(required(parsed, "--class"));
  const words = required(parsed, "--words");
  const thread = required(parsed, "--thread");
  const events = await reachHub(() => ledger.read());
  const brake = brakeOf(events, decisionClass);
  if (!brake) throw new Error(`The ${decisionClass} class is not braked, so there is nothing to lift`);
  const heard = await heardInThread(thread, words, context);
  if (heard.source !== "question") throw new Error(`"${heard.text}" is a message the user typed. Only their answer to your question tool lifts a brake: ask them with it`);
  const earlier = events.find((event): event is Lift => event.type === "lift" && event.thread === heard.thread && event.message === heard.id);
  if (earlier) throw new Error(`That message already lifted the ${earlier.class} brake on ${earlier.at.slice(0, 10)}. One message lifts one brake; ask the user about this one`);
  if (Date.parse(heard.at) <= Date.parse(brake.at)) throw new Error(`The user wrote that before the brake, which the reversal of ${brake.ids[1]} set on ${brake.at.slice(0, 10)}. Only an answer after it lifts it; ask them`);
  await reachHub(() => ledger.append({ type: "lift", class: decisionClass, words, thread: heard.thread, message: heard.id, machine: thisMachine(context.env), at: at(context) }));
  context.print(`Lifted the brake on ${decisionClass} (reversals of ${brake.ids[0]} and ${brake.ids[1]}): the agent decides its asks alone again. (the user, ${words}, thread ${thread})`);
  return 0;
}

async function list(parsed: Parsed, context: DecisionContext, ledger: Ledger) {
  const ref = parsed.options.has("--pr") ? prRef(parsed.options.get("--pr")!) : undefined;
  const decisionClass = parsed.options.has("--class") ? askClass(parsed.options.get("--class")!) : undefined;
  const shown = fold(await reachHub(() => ledger.read())).filter((decision) =>
    (!ref || covers(decision, ref)) && (!decisionClass || decision.class === decisionClass) && (!parsed.flags.has("--live") || live(decision)));
  if (!shown.length) context.print("No decisions.");
  for (const decision of shown) context.print(decisionLine(decision));
  return 0;
}

export const ledgerOf = (context: Pick<DecisionContext, "home" | "env" | "ssh" | "ledger">) => context.ledger ?? hubLedger(context.home, context.env, context.ssh);

export const pullBodyOf = (context: Pick<DecisionContext, "cwd" | "env" | "pullBody">) =>
  context.pullBody ?? (async (ref: PrRef) => readPullRequest({ ...ref, commit: "" }, runIn(context.cwd, context.env)).body);

export async function decisionCommand(args: string[], context: DecisionContext): Promise<number> {
  const name = args.shift();
  if (name === undefined || ["help", "--help", "-h"].includes(name) || args.includes("--help")) { context.print(usage); return name === undefined ? 1 : 0; }
  const ledger = ledgerOf(context);
  if (name === "record") return record(parse(args, ["--mark", "--words", "--message", "--thread", "--class", "--condition", "--question", "--answer", "--rejected", "--reason", "--link"], ["--pr", "--kind"], ["--keep-owed"]), context, ledger);
  if (name === "list") return list(parse(args, ["--pr", "--class"], [], ["--live"]), context, ledger);
  if (name === "void") return voidDecision(parse(args, ["--reason"], [], []), context, ledger);
  if (name === "reverse") return reverse(parse(args, ["--words", "--thread", "--comment"], [], []), context, ledger);
  if (name === "report") {
    const parsed = parse(args, ["--thread"], ["--pr"], []);
    const prs = prsOf(parsed);
    if (!prs.length) throw new Error("--pr is required: name each PR of the lane. Run fleet decision --help");
    const { renderReport } = await import("./decision-report.ts");
    context.print(await renderReport({ prs, thread: parsed.options.get("--thread") ?? context.env.T3CODE_THREAD_ID }, fold(await reachHub(() => ledger.read())), context));
    return 0;
  }
  if (name === "lift") return lift(parse(args, ["--class", "--words", "--thread"], [], []), context, ledger);
  throw new Error(`Unknown command ${name}. Run fleet decision --help`);
}

const acceptsGap = (words: string) => /^(accept|yes)\b/.test(normalized(words));
