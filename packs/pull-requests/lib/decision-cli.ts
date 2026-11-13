import { normalized, t3ThreadWords, type HeardAnswer, type ThreadWord, type ThreadWords } from "./proof-answers.ts";
import { readPullRequest, runIn } from "./pr-ci.ts";
import { gapKind, refuseInstructionQuote, usedAnswer } from "./proof.ts";
import {
  agentRefusal, askClasses, covers, decisionLine, fold, hubLedger, HubUnreachable, isUsers, live, messageKey, namesKind, namesPr, panelRefusal, prRef, refText, thisMachine, tierOf,
  type AskClass, type Decision, type Env, type Ledger, type PrRef, type Ssh, type UsersMark,
} from "./decision-ledger.ts";

export type DecisionContext = {
  home: string; cwd: string; env: Env; print: (text: string) => void; now?: () => Date;
  threadWords?: ThreadWords; ssh?: Ssh;
};

const usage = `Usage:
  fleet decision record --mark 👤|👍 --class <class> --pr <owner/repo#n>... [--kind <kind>...] [--thread <id>] [--message <id> | --words '<date> "<the user's words>"'] [--condition <text>] [--keep-owed]
  fleet decision record --mark 🤖 --class <class> --pr <owner/repo#n>... --question <q> --answer <a> --rejected <option> --reason <why> [--kind <kind>...] [--condition <text>] [--thread <id>]
  fleet decision list [--pr <owner/repo#n>] [--class <class>] [--live]
  fleet decision void <id> --reason <why its condition no longer holds>

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
keeps them owed whatever an agent decides. A decision of the user's takes the time they answered. --condition names
what must stay true at HEAD; the judge checks it. Classes: ${askClasses.join(", ")}.
record with 🤖 records the agent's own decision with the option it rejected. Fleet reads each PR's Tier line in its
merge-risk callout at HEAD: it refuses an ungraded PR, and on a critical PR anything but process (review and status
asks, judge and post-deploy-watch gaps). It never takes a panel gap: ${panelRefusal}. The gate never counts a 🤖 ci
acceptance over CI that ran, nor one under the user's keep-owed, and prints each 🤖 acceptance that lapsed on a kind
that stays open.
list prints the decisions as decision lines with their ids. Run it before you ask.
void ends a decision whose condition HEAD no longer meets, such as when the judge fails it; then decide or ask again.
It refuses the user's keep-owed: only their acceptance lifts it.`;

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
        id: newId(), at: answeredAt(word), class: input.class, mark: input.mark, question: word.answered, answer: `${word.at.slice(0, 10)} "${word.text}"`, scope: scopeOf(input),
        ...input.class === "proof-gap" ? { effect: input.keepOwed ? "keep-owed" as const : "accept" as const } : {}, where,
      };
    } catch (error) { refusals.push(error as Error); }
  }
  throw used ?? refusals[0]!;
}

function answeredAt(word: ThreadWord) {
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
  const decisions = fold(await reachHub(() => ledger.read()));
  const winner = decision.where.message && decisions.find((recorded) => messageKey(recorded.where) === messageKey(decision.where));
  if (winner && winner.id !== decision.id) throw alreadyRecorded(winner.id);
  if (decisions.some((recorded) => recorded.id === decision.id)) return decision.id;
  if (unacknowledged) notRecorded(unacknowledged);
  throw new Error(`Not recorded: decision ${decision.id} is not in the decision ledger when Fleet reads it back. Run the same command again`);
}

const unreachableOnly = (error: unknown) => { if (error instanceof HubUnreachable) return error; throw error; };

const prsOf = (parsed: Parsed) => (parsed.lists.get("--pr") ?? []).map(prRef);

export type AgentDecision = Scope & { question: string; answer: string; rejected: string; reason: string; thread?: string };

export async function decideAlone(input: AgentDecision, context: DecisionContext): Promise<Decision> {
  checkScope(input);
  for (const [name, value] of Object.entries({ "--question": input.question, "--answer": input.answer, "--rejected": input.rejected, "--reason": input.reason })) {
    if (!value.trim()) throw new Error(`An agent decision needs ${name}`);
  }
  const thread = input.thread ?? context.env.T3CODE_THREAD_ID;
  if (!thread) throw new Error("An agent decision needs --thread with this lane's T3 thread id");
  if (agentRefusal("non-critical", input.class, input.kinds) === "panel") throw new Error(`${input.prs.map(refText).join(", ")}: ${panelRefusal}. Ask them with your question tool and record their answer with --mark 👤`);
  for (const ref of input.prs) {
    const refusal = agentRefusal(tierOf(await pullBody(ref, context).catch(() => "")), input.class, input.kinds);
    if (refusal === "ungraded") throw new Error(`${refText(ref)} is ungraded: its merge-risk callout has no Tier line at HEAD. An agent never decides alone on an ungraded PR; grade it with merge-risk, or ask the user`);
    if (refusal) throw new Error(`${refText(ref)} is critical at HEAD: an agent decides only process there (review and status asks, judge and post-deploy-watch gaps). Ask the user`);
  }
  return {
    id: newId(), at: at(context), class: input.class, mark: "🤖", question: input.question, answer: input.answer,
    rejected: input.rejected, reason: input.reason, scope: scopeOf(input), ...input.class === "proof-gap" ? { effect: "accept" as const } : {},
    where: { thread, machine: thisMachine(context.env) },
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
    decision = await decideAlone({ ...scope, question: required(parsed, "--question"), answer: required(parsed, "--answer"), rejected: required(parsed, "--rejected"), reason: required(parsed, "--reason"), thread: parsed.options.get("--thread") }, context);
  } else if (mark === "👤" || mark === "👍") {
    for (const option of ["--question", "--answer", "--rejected", "--reason"]) if (parsed.options.has(option)) throw new Error(`${option} belongs to the agent's own decision. The user's decision takes its question and answer from T3`);
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
  if (isUsers(decision) && decision.effect === "keep-owed") throw new Error(`Decision ${id} keeps the gap owed, and only the user lifts it: ask them with your question tool, and record their acceptance with --mark 👤`);
  const voidedAt = at(context);
  await reachHub(() => ledger.append({ type: "void", id, reason, at: voidedAt }));
  context.print(decisionLine({ ...decision, voided: { reason, at: voidedAt } }));
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
  if (name === "record") return record(parse(args, ["--mark", "--words", "--message", "--thread", "--class", "--condition", "--question", "--answer", "--rejected", "--reason"], ["--pr", "--kind"], ["--keep-owed"]), context, ledger);
  if (name === "list") return list(parse(args, ["--pr", "--class"], [], ["--live"]), context, ledger);
  if (name === "void") return voidDecision(parse(args, ["--reason"], [], []), context, ledger);
  throw new Error(`Unknown command ${name}. Run fleet decision --help`);
}

const acceptsGap = (words: string) => /^(accept|yes)\b/.test(normalized(words));
const saysYes = (words: string) => /^yes\b/.test(normalized(words));
