import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { optionalStringSetting } from "../../base/lib/settings.ts";

export const askClasses = ["proof-gap", "review", "merge", "deploy", "secret", "design", "scope", "status"] as const;
export type AskClass = (typeof askClasses)[number];
export const marks = ["👤", "👍", "🤖"] as const;
export type Mark = (typeof marks)[number];
export type UsersMark = "👤" | "👍";
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
      const torn = await readFile(path, "utf8").then((text) => text !== "" && !text.endsWith("\n"), () => false);
      await appendFile(path, (torn ? "\n" : "") + lines(events), { mode: 0o600 });
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
      const result = await ssh(hub, `umask 077 && f=${remoteFile} && mkdir -p "$(dirname "$f")" && t=$(mktemp "$f.XXXXXX") && { [ ! -s "$f" ] || [ -z "$(tail -c 1 "$f")" ] || printf '\\n' >> "$t"; } && cat >> "$t" && cat "$t" >> "$f"; s=$?; rm -f "$t"; exit $s`, lines(events));
      if (result.code !== 0) throw unreachable(result);
    },
  };
}

const runSsh: Ssh = async (host, command, stdin) => {
  const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code: code ?? 255, stdout, stderr };
};

export type Env = Record<string, string | undefined>;

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

export const messageKey = ({ thread, message }: Decision["where"]) => message && `${thread}/${message}`;

export const brakeDays = 28;
const dayMs = 24 * 60 * 60 * 1000;
export type Brake = { ids: [string, string]; at: string };

const liftKey = (lift: Lift) => `${lift.thread}/${lift.message}`;

function replay(events: LedgerEvent[]) {
  const decisions = new Map<string, DecisionState>();
  const messages = new Set<string>();
  const reversals = new Map<AskClass, { id: string; time: number }[]>();
  const brakes = new Map<AskClass, Brake>();
  const lifts = new Set<Lift>();
  const liftedBy = new Set<string>();
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
      const brake = brakes.get(event.class);
      if (!brake || liftedBy.has(liftKey(event)) || Date.parse(event.at) <= Date.parse(brake.at)) continue;
      liftedBy.add(liftKey(event));
      lifts.add(event);
      reversals.delete(event.class);
      brakes.delete(event.class);
    } else {
      const decision = decisions.get(event.id);
      if (!decision || decision.reversed) continue;
      const { rejected, ...rest } = decision;
      decisions.set(event.id, { ...rest, mark: "👤", answer: event.words, reversed: { at: event.at, mark: decision.mark, answer: decision.answer, ...rejected ? { rejected } : {} } });
      if (decision.mark !== "🤖") continue;
      const time = Date.parse(event.at);
      const earlier = reversals.get(decision.class) ?? [];
      const close = earlier.find((other) => Math.abs(time - other.time) <= brakeDays * dayMs);
      if (close && !brakes.has(decision.class)) {
        const [first, later] = [close, { id: event.id, time }].sort((a, b) => a.time - b.time) as [{ id: string; time: number }, { id: string; time: number }];
        brakes.set(decision.class, { ids: [first.id, later.id], at: new Date(later.time).toISOString() });
      }
      reversals.set(decision.class, [...earlier, { id: event.id, time }]);
    }
  }
  return { decisions: [...decisions.values()], brakes, lifts };
}

export const fold = (events: LedgerEvent[]): DecisionState[] => replay(events).decisions;
export const brakeOf = (events: LedgerEvent[], decisionClass: AskClass): Brake | undefined => replay(events).brakes.get(decisionClass);
export const liftCounted = (events: LedgerEvent[], lift: Lift) => [...replay(events).lifts].some((counted) => JSON.stringify(counted) === JSON.stringify(lift));

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

export const namesKind = (question: string, kind: string) => new RegExp(`(?<![\\w-])${escape(kind)}(?![\\w-])`, "i").test(question);

const who = (mark: Mark) => mark === "🤖" ? "agent" : "the user";

const rejectedText = (rejected: string | undefined) => rejected ? ` Rejected: ${rejected}.` : "";

export function decisionLine(decision: DecisionState) {
  const { reversed } = decision;
  const replaced = reversed ? ` (reversed ${reversed.at.slice(0, 10)} from ~~${reversed.mark} ${reversed.answer}${rejectedText(reversed.rejected)}~~)` : "";
  const state = decision.voided ? ` voided: ${decision.voided.reason}` : "";
  return `- ${decision.mark} **${decision.question}** ${decision.answer}${rejectedText(decision.rejected)}${replaced} (${who(decision.mark)}, ${decision.class}, thread ${decision.where.thread}) [${decision.id}]${state}`;
}

export const live = (decision: DecisionState) => !decision.voided && !decision.reversed;
export const isUsers = (decision: Decision) => decision.mark === "👤" || decision.mark === "👍";
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
