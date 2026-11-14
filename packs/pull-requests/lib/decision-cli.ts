import { normalized, t3ThreadWords, type HeardAnswer, type ThreadWord, type ThreadWords } from "./proof-answers.ts";
import { renderReport } from "./decision-report.ts";
import { readPullRequest, runIn } from "./pr-ci.ts";
import { gapKind, refuseInstructionQuote, usedAnswer } from "./proof.ts";
import {
  agentRefusal, answerUse, askClasses, brakeDays, brakeOf, covers, decisionLine, fold, hubLedger, HubUnreachable, isUsers, liftCounted, live, messageKey, namesKind, namesPr, panelRefusal, prRef, refText, thisMachine, tierOf,
  type AnswerUse, type AskClass, type Decision, type DecisionState, type Env, type Ledger, type LedgerEvent, type Lift, type PrRef, type Reversal, type Ssh, type UsersMark,
} from "./decision-ledger.ts";

export type DecisionContext = {
  home: string; cwd: string; env: Env; print: (text: string) => void; now?: () => Date;
  threadWords?: ThreadWords; ssh?: Ssh; pendingCard?: (thread: string) => Promise<boolean>;
};

const usage = `Usage:
  fleet decision record --mark 👤|👍 --class <class> --pr <owner/repo#n>... [--kind <kind>...] [--thread <id>] [--message <id> | --words '<date> "<the user's words>"'] [--condition <text>] [--keep-owed]
  fleet decision record --mark 🤖 --class <class> --pr <owner/repo#n>... --question <q> --answer <a> --rejected <option> --reason <why> [--kind <kind>...] [--condition <text>] [--thread <id>] [--link <side-fix thread>]
  fleet decision list [--pr <owner/repo#n>] [--class <class>] [--live]
  fleet decision void <id> --reason <why its condition no longer holds>
  fleet decision reverse <id> --words '<date> "<the user's words>"' --thread <id> [--message <id>]
  fleet decision lift --class <class> --words '<date> "<the user's answer>"' --thread <id> [--message <id>]
  fleet decision report --pr <owner/repo#n>... [--thread <id>]

The decision ledger holds every decision about a pull request's proof and process. It lives on the Fleet hub that
the setting hub.alias names; other machines read and append it over SSH. Without a hub, it lives on this machine.

record with 👤 or 👍 records the user's answer to your question tool. Without --words it takes their latest answer
in the T3 thread whose question names each --pr and each --kind: after they answer, pass only the mark, class, kinds and PRs, and
check the answer in the printed line. --message takes an earlier answer by its id. --words quotes the words of an
answer, with the date they gave it. --thread defaults to this T3 thread (T3CODE_THREAD_ID). Only answers to a
question tool in the T3 app count; a typed message does not. Each --pr must be named in that question (#n,
repo#n, owner/repo#n, or its URL), so one answer covers every PR its question named and no other. One answer
records one decision. With --class proof-gap and --kind, the decision accepts those gaps of each PR, and the user's
choice must start with "Accept", or be "Yes" to a question that starts with "Accept the <kind> gap?"; with --keep-owed, it
keeps them owed whatever an agent decides. A decision of the user's takes the time they answered: record a gap with
fleet proof gap before you ask, since a judge gap counts only answers given after it was recorded. --condition names
what must stay true at HEAD; the judge checks it. Classes: ${askClasses.join(", ")}.
record with 🤖 records the agent's own decision with the option it rejected. Fleet reads each PR's Tier line in its
merge-risk callout at HEAD: it refuses an ungraded PR, and on a critical PR anything but process (review and status
asks, judge and post-deploy-watch gaps). It never takes a panel gap: ${panelRefusal}. The gate never counts a 🤖 ci
acceptance over CI that ran, nor one under the user's keep-owed, and prints each 🤖 acceptance that lapsed on a kind
that stays open.
list prints the decisions as decision lines with their ids. Run it before you ask.
void ends a decision whose condition HEAD no longer meets, such as when the judge fails it; then decide or ask again.
It refuses the user's keep-owed: only their acceptance lifts it.
reverse records the user's reversal of a decision: their dated, quoted words in a message they typed in the T3 app,
or their answer to your question tool there. Agents post on GitHub as the user, so a GitHub comment never reverses a
decision. The message must say the words on the quoted date; when two messages on that date do, --message picks one
by its id. One answer reverses one decision. The user's words must be newer than the decision, and the reversal
takes the time they wrote them. The decision then prints as 👤 with their words, the replaced answer struck through,
and counts no more at the gate or in list --live; decide or ask again. Once the reversal holds, reverse writes a void
too, so an older Fleet stops counting the decision; when the hub drops that void, run the same command again. It
refuses the user's keep-owed, as void does, and a voided decision. Two reversals of 🤖 decisions in one class within
${brakeDays} days brake the class from the later of the two: record --mark 🤖 and fleet proof review --agent in it
are refused until lift records the user's answer to your question tool. The question must name the brake and the
class, and the answer must be given after the brake. An answer that starts with "Lift" lifts it; a "Yes" lifts it only
when the question starts with "Lift the brake on <class>", such as "Lift the brake on design decisions?". One answer
lifts one brake or records one decision, never both: record refuses an answer a lift used, lift refuses one a decision
used, and each reads the ledger back and fails when the other used it first. A 🤖 decision that lands while its class is braked counts nowhere.
record --mark 🤖 --class scope takes --link with the T3 thread a side fix started in.
report prints the lane's end-of-run report in Markdown, in five sections: still yours (unaccepted gaps on critical
heads first, judge gaps too, a question card that waits in --thread, PRs whose proofs it cannot read, PRs that no
gate has judged at their HEAD with their current proofs, open PRs whose proofs do not pass as read now, then open
PRs whose full gate passed, judge included, and wait on the user's merge word), PRs merged under the narrow grant (merged lines of the rollout log that
orchestration.rolloutLog names, whose note names the narrow grant), the lane's decisions sorted 👤 👍 🤖, one proofs
row per PR from the proof summary the gate saved at its HEAD on GitHub, with its receipt link, and the side fixes the
lane started. The report never runs the judge. It builds each PR's proof summary again at HEAD, so CI, standing
rules, decisions and the tier are read as they are now, and takes the judge's verdict from the summary fleet proof gate
saved, only while the PR's head, base and base SHA on GitHub, its tier and merge-risk callout, --landed for a merged PR, and the PR's proof
files, standing rules and ledger decisions are the same. Otherwise it says the gate has not run at HEAD with these
proofs; a decision recorded after the gate counts as a change. A summary that does not pass now offers no merge,
and nor does an accepted gap whose condition the saved judge did not weigh, CI checks other than the ones it weighed,
or a head, base, tier or callout that moves while the report reads it: run the gate in the PR's checkout (with --landed for a merged PR), where a review carried across commits can
be checked. --thread defaults to this T3 thread.
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

function notRecorded(error: unknown): never {
  if (!(error instanceof HubUnreachable)) throw error;
  throw new Error(`Not recorded: ${error.message}. Run the same command again once the hub is back`);
}

async function reachHub<T>(step: () => Promise<T>) {
  try { return await step(); }
  catch (error) { return notRecorded(error); }
}

const newId = () => `d-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
const at = (context: DecisionContext) => (context.now?.() ?? new Date()).toISOString();
export class AnswerTaken extends Error {}
const alreadyRecorded = (id: string) => new AnswerTaken(`That answer is already recorded as decision ${id}. One answer records one decision; it covers the PRs its question named. Ask the user again`);
const alreadyLifted = (lifted: Lift) => new AnswerTaken(`That answer already lifted the ${lifted.class} brake on ${lifted.at.slice(0, 10)}. One answer lifts one brake or records one decision; ask the user again`);
const alreadyReversed = (id: string) => new AnswerTaken(`That answer already reversed decision ${id}. One answer reverses one decision; ask the user about this one`);
const alreadyUsed = (use: AnswerUse) => "decision" in use ? alreadyRecorded(use.decision) : "lift" in use ? alreadyLifted(use.lift) : alreadyReversed(use.reversal);

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
      const earlier = answerUse(await reachHub(() => ledger.read()), messageKey(where));
      if (earlier) { used ??= alreadyUsed(earlier); continue; }
      const usedOn = await usedAnswer(context.home, heard);
      if (usedOn) { used ??= new Error(usedOn); continue; }
      return {
        id: newId(), at: answeredAt(word), class: input.class, mark: input.mark, question: word.answered, answer: `${word.at.slice(0, 10)} "${word.text}"`, scope: scopeOf(input),
        ...input.class === "proof-gap" ? { effect: input.keepOwed ? "keep-owed" as const : "accept" as const } : {}, where,
      };
    } catch (error) { refusals.push(error as Error); }
  }
  throw used ?? refusals[0]!;
}

export function answeredAt(word: ThreadWord) {
  const time = Date.parse(word.at);
  if (Number.isNaN(time)) throw new Error(`T3 gives no time for the user's answer ${word.id} in thread ${word.thread}. Ask them again`);
  return new Date(time).toISOString();
}

const heardAnswer = (word: ThreadWord): HeardAnswer => ({ thread: word.thread, message: word.id, words: word.text, answered: word.answered, at: word.at, source: word.source });

function candidates(answers: ThreadWord[], { words, message, prs, kinds = [] }: Hearing, thread: string): ThreadWord[] {
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
  const latest = answers.findLast((word) => word.source === "question" && prs.every((ref) => namesPr(word.answered, ref)) && kinds.every((kind) => namesKind(word.answered, kind)));
  if (!latest) throw new Error(`No answer of the user's to a question tool in thread ${thread} names ${[...prs.map(refText), ...kinds.map((kind) => `the ${kind} gap`)].join(", ")}. Ask them with the question tool and name each PR in the question. Only answers they gave in the T3 app count`);
  return [latest];
}

function fits(heard: HeardAnswer, input: Hearing) {
  input.fits?.(heard);
  if (heard.source !== "question") throw new Error(`"${heard.words}" is a message the user typed. Only their answer to your question tool counts: ask them with it and name each PR in the question`);
  const unnamed = input.prs.filter((ref) => !namesPr(heard.answered, ref));
  if (unnamed.length) throw new Error(`The question the user answered does not name ${unnamed.map(refText).join(", ")}. An answer covers only the PRs its question named; ask them about the others. The question: ${heard.answered}`);
  const unnamedKinds = (input.kinds ?? []).filter((kind) => !namesKind(heard.answered, kind));
  if (unnamedKinds.length) throw new Error(`The question the user answered does not name the ${unnamedKinds.join(", ")} gap. Ask them about each gap kind by name. The question: ${heard.answered}`);
  if (input.class !== "proof-gap" || input.keepOwed) return;
  if (!acceptsGap(heard.words)) throw new Error(`The user chose "${heard.words}", which does not accept the gap. The gap stays open`);
  const asked = acceptQuestion(input.kinds ?? []);
  if (saysYes(heard.words) && !normalized(heard.answered).startsWith(normalized(asked))) throw new Error(`The user chose "${heard.words}" to a question that does not ask "${asked}". A plain yes accepts only the question that asks it; the gap stays open. The question: ${heard.answered}`);
}

const acceptQuestion = (kinds: string[]) => `Accept the ${kinds.join(" and ")} ${kinds.length === 1 ? "gap" : "gaps"}?`;

export async function appendDecision(ledger: Ledger, decision: Decision) {
  const unacknowledged = await ledger.append({ type: "decide", decision }).then(() => undefined, unreachableOnly);
  const events = await reachHub(() => ledger.read());
  const decisions = fold(events);
  const winner = decision.where.message && decisions.find((recorded) => messageKey(recorded.where) === messageKey(decision.where));
  if (winner && winner.id !== decision.id) throw alreadyRecorded(winner.id);
  if (decisions.some((recorded) => recorded.id === decision.id)) return decision.id;
  const lifted = answerUse(events, messageKey(decision.where));
  if (lifted && "lift" in lifted) throw alreadyLifted(lifted.lift);
  if (unacknowledged) notRecorded(unacknowledged);
  if (decision.mark === "🤖" && brakeOf(events, decision.class)) {
    throw new Error(`The ${decision.class} class was braked while this decision was recorded, so it counts nowhere. An agent decides no ${decision.class} ask alone until the user lifts the brake; ask them`);
  }
  throw new Error(`Not recorded: decision ${decision.id} is not in the decision ledger when Fleet reads it back. Run the same command again`);
}

async function appendHeard(ledger: Ledger, ...events: LedgerEvent[]) {
  const unacknowledged = await ledger.append(...events).then(() => undefined, unreachableOnly);
  const read = await reachHub(() => ledger.read());
  const recorded = new Set(read.map((event) => JSON.stringify(event)));
  if (events.every((event) => recorded.has(JSON.stringify(event)))) return read;
  if (unacknowledged) notRecorded(unacknowledged);
  throw new Error("Not recorded: the event is not in the decision ledger when Fleet reads it back. Run the same command again");
}

export const ledgerHolds = async (ledger: Ledger, id: string) => fold(await ledger.read()).some((recorded) => recorded.id === id);
export const inLedger = (ledger: Ledger, id: string) => reachHub(() => ledgerHolds(ledger, id));

export async function appendOnce(ledger: Ledger, decision: Decision) {
  if (await inLedger(ledger, decision.id)) return decision.id;
  return appendDecision(ledger, decision);
}

const unreachableOnly = (error: unknown) => { if (error instanceof HubUnreachable) return error; throw error; };

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
  for (const ref of input.prs) {
    const refusal = agentRefusal(tierOf(await pullBody(ref, context).catch(() => "")), input.class, input.kinds);
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
  refuseKeptOwed(decision);
  const voidedAt = at(context);
  await reachHub(() => ledger.append({ type: "void", id, reason, at: voidedAt }));
  context.print(decisionLine({ ...decision, voided: { reason, at: voidedAt } }));
  return 0;
}

const refuseKeptOwed = (decision: DecisionState) => {
  if (isUsers(decision) && decision.effect === "keep-owed") throw new Error(`Decision ${decision.id} keeps the gap owed, and only the user lifts it: ask them with your question tool, and record their acceptance with --mark 👤`);
};

const quoteWithDate = () => new Error(`Quote the user's words with the date they wrote them, such as '2026-10-24 "Reverse that."'`);
const quotedDate = (words: string) => /\b\d{4}-\d{2}-\d{2}\b/.exec(words)![0];

export async function heardInThread(thread: string, words: string, message: string | undefined, context: DecisionContext) {
  if (!isDatedQuote(words)) throw quoteWithDate();
  await refuseInstructionQuote(context.home, words);
  const text = quotes(words).join(" ");
  const date = quotedDate(words);
  const answers = await (context.threadWords ?? t3ThreadWords(context.home))(thread);
  if (message !== undefined) {
    const named = answers.find((word) => word.id === message);
    if (!named || normalized(named.text) !== text || named.at.slice(0, 10) !== date) throw new Error(`Message ${message} of the user's in thread ${thread} does not say "${text}" on ${date}`);
    return named;
  }
  const said = answers.filter((word) => normalized(word.text) === text);
  if (!said.length) throw new Error(`"${quotes(words).join('" … "')}" is not in a message of the user's in thread ${thread}. Quote their whole message`);
  const onDate = said.filter((word) => word.at.slice(0, 10) === date);
  if (!onDate.length) throw new Error(`The user did not write "${text}" on ${date} in thread ${thread}. Quote the date they wrote it`);
  if (onDate.length > 1) throw new Error(`${onDate.length} messages of the user's in thread ${thread} on ${date} say "${text}". Pass --message with the id of the one they meant: ${onDate.map((word) => word.id).join(", ")}`);
  return onDate[0]!;
}

async function repairVoid(decision: DecisionState, at: string, events: LedgerEvent[], context: DecisionContext, ledger: Ledger) {
  if (events.some((event) => event.type === "void" && event.id === decision.id && event.at === at)) throw new Error(`Decision ${decision.id} is already reversed, on ${at.slice(0, 10)}`);
  await appendHeard(ledger, { type: "void", id: decision.id, reason: `reversed by the user: ${decision.answer}`, at });
  context.print(`${decisionLine(decision)}\nFleet wrote the void of the reversal of ${decision.id} for older readers: the hub had dropped it.`);
  return 0;
}

async function reverse(parsed: Parsed, context: DecisionContext, ledger: Ledger) {
  const [id, ...rest] = parsed.positional;
  if (!id || rest.length) throw new Error("Name one decision id. Run fleet decision --help");
  const words = required(parsed, "--words");
  const thread = parsed.options.get("--thread");
  if (thread === undefined) throw new Error("Pass --thread with the T3 thread where the user reversed it. Run fleet decision --help");
  const events = await reachHub(() => ledger.read());
  const decision = fold(events).find((candidate) => candidate.id === id);
  if (!decision) throw new Error(`No decision ${id} in the ledger. Run fleet decision list`);
  if (decision.reversed) return repairVoid(decision, decision.reversed.at, events, context, ledger);
  if (decision.voided) throw new Error(`Decision ${id} is voided: ${decision.voided.reason}. It counts no more, so there is nothing to reverse`);
  refuseKeptOwed(decision);
  const word = await heardInThread(thread, words, parsed.options.get("--message"), context);
  const heard = { thread: word.thread, message: word.id, at: answeredAt(word) };
  if (Date.parse(heard.at) < Date.parse(decision.at)) throw new Error(`The user wrote that on ${heard.at.slice(0, 10)}, before decision ${id} was recorded on ${decision.at.slice(0, 10)}. Only their words after it reverse it`);
  const event: Reversal = { type: "reverse", id, words, ...heard, machine: thisMachine(context.env) };
  const answer = `${heard.thread}/${heard.message}`;
  const earlier = answerUse(events, answer);
  if (earlier) throw alreadyUsed(earlier);
  const after = await appendHeard(ledger, event);
  const use = answerUse(after, answer);
  if (!use && fold(after).find((candidate) => candidate.id === id)?.voided) throw new Error(`Not reversed: decision ${id} was voided first, so it counts no more`);
  if (!use || !("reversal" in use) || use.reversal !== id) throw new Error(`Not reversed: ${use ? alreadyUsed(use).message : `another reversal of decision ${id} came first`}`);
  await appendHeard(ledger, { type: "void", id, reason: `reversed by the user: ${words}`, at: event.at });
  context.print(decisionLine(fold([...events, event]).find((candidate) => candidate.id === id)!));
  return 0;
}

const namesBrake = (question: string, decisionClass: AskClass) => /\bbrake\b/i.test(question) && namesKind(question, decisionClass);
const liftQuestion = (decisionClass: AskClass) => `Lift the brake on ${decisionClass}`;

function refuseUnlifting(heard: ThreadWord, decisionClass: AskClass) {
  if (!namesBrake(heard.answered, decisionClass)) throw new Error(`The question the user answered does not ask to lift the ${decisionClass} brake. The question: ${heard.answered}`);
  const answer = normalized(heard.text);
  if (/^lift\b/.test(answer)) return;
  if (!/^yes\b/.test(answer)) throw new Error(`The user chose "${heard.text}", which does not lift the ${decisionClass} brake. It stays on`);
  if (!normalized(heard.answered).startsWith(normalized(liftQuestion(decisionClass)))) throw new Error(`The user chose "${heard.text}" to a question that does not start with "${liftQuestion(decisionClass)}". A plain yes lifts only the question that asks it; the brake stays on. The question: ${heard.answered}`);
}

async function lift(parsed: Parsed, context: DecisionContext, ledger: Ledger) {
  const decisionClass = askClass(required(parsed, "--class"));
  const words = required(parsed, "--words");
  const thread = required(parsed, "--thread");
  const events = await reachHub(() => ledger.read());
  const brake = brakeOf(events, decisionClass);
  if (!brake) throw new Error(`The ${decisionClass} class is not braked, so there is nothing to lift`);
  const heard = await heardInThread(thread, words, parsed.options.get("--message"), context);
  if (heard.source !== "question") throw new Error(`"${heard.text}" is a message the user typed. Only their answer to your question tool lifts a brake: ask them with it`);
  refuseUnlifting(heard, decisionClass);
  const decided = fold(events).find((decision) => messageKey(decision.where) === `${heard.thread}/${heard.id}`);
  if (decided) throw alreadyRecorded(decided.id);
  const usedOn = await usedAnswer(context.home, heardAnswer(heard));
  if (usedOn) throw new Error(usedOn);
  const earlier = events.find((event): event is Lift => event.type === "lift" && event.thread === heard.thread && event.message === heard.id);
  if (earlier) throw new Error(`That message already lifted the ${earlier.class} brake on ${earlier.at.slice(0, 10)}. One message lifts one brake; ask the user about this one`);
  const answered = answeredAt(heard);
  if (Date.parse(answered) <= Date.parse(brake.at)) throw new Error(`The user wrote that before the brake, which the reversal of ${brake.ids[1]} set on ${brake.at.slice(0, 10)}. Only an answer after it lifts it; ask them`);
  const event: Lift = { type: "lift", class: decisionClass, words, thread: heard.thread, message: heard.id, machine: thisMachine(context.env), at: answered };
  const read = await appendHeard(ledger, event);
  if (!liftCounted(read, event)) {
    const use = answerUse(read, `${heard.thread}/${heard.id}`);
    if (use && "decision" in use) throw new Error(`Not lifted: decision ${use.decision} used that answer first. One answer lifts one brake or records one decision; ask the user again`);
    throw new Error("Not lifted: another lift used that answer first, or the brake changed while Fleet recorded it. One answer lifts one brake; ask the user again");
  }
  context.print(`Lifted the brake on ${decisionClass} (reversals of ${brake.ids[0]} and ${brake.ids[1]}): the agent decides its asks alone again. (the user, ${words}, thread ${thread})`);
  return 0;
}

async function report(parsed: Parsed, context: DecisionContext, ledger: Ledger) {
  const prs = prsOf(parsed);
  if (!prs.length) throw new Error("--pr is required: name each PR of the lane. Run fleet decision --help");
  const events = await reachHub(() => ledger.read());
  const read: Ledger = { read: async () => events, append: (...added) => ledger.append(...added) };
  context.print(await renderReport({ prs, thread: parsed.options.get("--thread") ?? context.env.T3CODE_THREAD_ID }, read, fold(events), context));
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

export const ledgerOf = (context: Pick<DecisionContext, "home" | "env" | "ssh">) => hubLedger(context.home, context.env, context.ssh);

const pullBody = async (ref: PrRef, { cwd, env }: DecisionContext) => readPullRequest({ ...ref, commit: "" }, runIn(cwd, env)).body;

export async function decisionCommand(args: string[], context: DecisionContext): Promise<number> {
  const name = args.shift();
  if (name === undefined || ["help", "--help", "-h"].includes(name) || args.includes("--help")) { context.print(usage); return name === undefined ? 1 : 0; }
  const ledger = ledgerOf(context);
  if (name === "record") return record(parse(args, ["--mark", "--words", "--message", "--thread", "--class", "--condition", "--question", "--answer", "--rejected", "--reason", "--link"], ["--pr", "--kind"], ["--keep-owed"]), context, ledger);
  if (name === "list") return list(parse(args, ["--pr", "--class"], [], ["--live"]), context, ledger);
  if (name === "void") return voidDecision(parse(args, ["--reason"], [], []), context, ledger);
  if (name === "reverse") return reverse(parse(args, ["--words", "--thread", "--message"], [], []), context, ledger);
  if (name === "lift") return lift(parse(args, ["--class", "--words", "--thread", "--message"], [], []), context, ledger);
  if (name === "report") return report(parse(args, ["--thread"], ["--pr"], []), context, ledger);
  throw new Error(`Unknown command ${name}. Run fleet decision --help`);
}

const acceptsGap = (words: string) => /^(accept|yes)\b/.test(normalized(words));
const saysYes = (words: string) => /^yes\b/.test(normalized(words));
