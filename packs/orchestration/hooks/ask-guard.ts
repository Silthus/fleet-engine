import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Hook, printing, runHook } from "../../base/lib/hook.ts";
import { findThread, matchThread, type ShellThread, t3CliRunner, t3UserData, type T3Deadline, withT3Session } from "../../base/lib/t3/index.ts";
import { asksForDecision, personName } from "../lib/prose-question.ts";

export type StopEvent = { transcript_path?: string; stop_hook_active?: boolean; last_assistant_message?: string };
export type StopBlock = { decision: "block"; reason: string };
export type IsTopLevel = (threadId: string | undefined, home: string) => Promise<boolean>;

type Line = { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown }; payload?: { type?: string; role?: string; name?: string; content?: unknown } };
type Block = { type?: string; text?: string; name?: string };
type Step = { text: string } | { asked: true };

export const questionToolReason = (person: string) => `Fleet blocked this stop: your last message asks ${person} a decision in prose. `
  + "While a PR watch, a thread wait, or a Monitor is awaited, T3 keeps this thread under Working, so the question never reaches them. "
  + "Ask it now with the question tool (AskUserQuestion in Claude, request_user_input in Codex): restate the decision in full, with options. "
  + `A pending question brings the thread back to ${person} even while it watches. If you asked nothing, end the turn again.`;

const questionTool = /(^|__)(AskUserQuestion|request_user_input)$/;

function parse(line: string): Line | undefined {
  try {
    return JSON.parse(line) as Line;
  } catch {
    return undefined;
  }
}

function isUserPrompt(line: Line | undefined): boolean {
  if (line?.type === "user" && !line.isMeta) {
    const content = line.message?.content;
    return typeof content === "string" || (Array.isArray(content) && content.some((block: Block) => block?.type === "text"));
  }
  return line?.type === "event_msg" && line.payload?.type === "user_message";
}

function steps(line: Line | undefined): Step[] {
  if (line?.type === "response_item" && line.payload?.type === "function_call") return questionTool.test(line.payload.name ?? "") ? [{ asked: true }] : [];
  const content = line?.type === "assistant" ? line.message?.content
    : line?.type === "response_item" && line.payload?.type === "message" && line.payload.role === "assistant" ? line.payload.content : undefined;
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: Block): Step[] => {
    if ((block?.type === "text" || block?.type === "output_text") && block.text) return [{ text: block.text }];
    return block?.type === "tool_use" && questionTool.test(block.name ?? "") ? [{ asked: true }] : [];
  });
}

function askedAfterLastMessage(turn: string[], finalMessage: string | undefined): { last?: string; asked: boolean } {
  const all = turn.flatMap((line) => steps(parse(line)));
  const at = finalMessage === undefined ? all.findLastIndex((step) => "text" in step) : all.findLastIndex((step) => "text" in step && step.text === finalMessage);
  const last = finalMessage ?? (at < 0 ? undefined : (all[at] as { text: string }).text);
  return { last, asked: at >= 0 && all.slice(at + 1).some((step) => "asked" in step) };
}

export function currentTurn(transcript: string): string[] {
  const lines = transcript.split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) if (isUserPrompt(parse(lines[index]!))) return lines.slice(index + 1);
  return lines;
}

const isTopLevelT3Thread: IsTopLevel = async (threadId, home) => {
  if (!threadId) return false;
  try {
    const thread = await withT3Session((client) => findThread(client, threadId), { home });
    return Boolean(thread && !thread.lineage?.parentThreadId);
  } catch {
    return false;
  }
};

export async function guardStop(event: StopEvent, home: string, threadId = process.env.T3CODE_THREAD_ID, topLevel: IsTopLevel = isTopLevelT3Thread): Promise<StopBlock | undefined> {
  if (event.stop_hook_active || !event.transcript_path) return undefined;
  let turn: string[];
  try {
    turn = currentTurn(await readFile(event.transcript_path, "utf8"));
  } catch {
    return undefined;
  }
  const { last, asked } = askedAfterLastMessage(turn, event.last_assistant_message);
  if (asked || !last || !asksForDecision(last)) return undefined;
  if (!(await topLevel(threadId, home))) return undefined;
  return { decision: "block", reason: questionToolReason(personName(home)) };
}

export type SendEvent = { session_id?: string; agent_id?: string; tool_name?: string; tool_input?: Record<string, unknown> };
export type SendDenial = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };
export type ReadShell = () => Promise<{ threads: ShellThread[] }>;
export type SendGuardOptions = { home: string; shell: ReadShell; deadline?: T3Deadline };

export const pendingCardReason = (threadId: string, person: string) => `Fleet blocked this send: thread ${threadId} waits on a pending question card. `
  + `A send in mode auto, steer or restart interrupts its turn, and T3 cancels the card, so its lane asks ${person} again or the card is lost. `
  + `Send again with mode: "queue": the lane reads your message once ${person} answers. `
  + "Only when your message changes what the card asks, send it once more unchanged to replace the card.";

export const killSwitch = ".config/fleet/ask-guard.off";

const isThreadSend = (name = "") => /^mcp__t3[-_]code__t3_thread_send$/.test(name);

function waitingCardKey(thread: ShellThread | undefined): string | undefined {
  const card = thread?.pendingRuntimeRequest as { id?: unknown; kind?: unknown } | null | undefined;
  if (card?.kind !== "user_input" || !thread?.activeRunId) return undefined;
  return typeof card.id === "string" ? card.id : thread.id;
}

async function isThisMachine(environmentId: unknown, home: string): Promise<boolean> {
  if (environmentId === undefined || environmentId === null || environmentId === "") return true;
  const here = await readFile(join(t3UserData(home), "environment-id"), "utf8").catch(() => "");
  return here.trim() === environmentId;
}

export const shellDeadlineMs = 6_000;

const timer: T3Deadline = (_what, ms, expire) => {
  const handle = setTimeout(expire, ms);
  return () => clearTimeout(handle);
};

async function readThreadsBefore(shell: ReadShell, deadline: T3Deadline): Promise<ShellThread[] | undefined> {
  let clear = () => {};
  const late = new Promise<undefined>((resolve) => (clear = deadline("the T3 shell snapshot", shellDeadlineMs, () => resolve(undefined))));
  try {
    return (await Promise.race([shell(), late]))?.threads;
  } catch {
    return undefined;
  } finally {
    clear();
  }
}

async function firstDenial(home: string, event: SendEvent, card: string): Promise<boolean> {
  const denials = join(home, ".local/state/fleet/ask-guard");
  const key = createHash("sha256").update([event.session_id ?? "", event.agent_id ?? "", card].join("\n")).digest("hex").slice(0, 32);
  try {
    await mkdir(denials, { recursive: true });
    await writeFile(join(denials, key), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export async function guardSend(event: SendEvent, options: SendGuardOptions): Promise<SendDenial | undefined> {
  const { threadId, mode } = event.tool_input ?? {};
  if (!isThreadSend(event.tool_name) || typeof threadId !== "string" || mode === "queue" || existsSync(join(options.home, killSwitch))) return undefined;
  if (!(await isThisMachine(event.tool_input?.environmentId, options.home))) return undefined;
  const threads = await readThreadsBefore(options.shell, options.deadline ?? timer);
  if (!threads) return undefined;
  const card = waitingCardKey(matchThread(threads, threadId, (thread) => thread.id));
  if (!card || !(await firstDenial(options.home, event, card))) return undefined;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: pendingCardReason(threadId, personName(options.home)) } };
}

const t3CallMs = 3_000;

const liveShell = (home: string): ReadShell => () =>
  withT3Session((client) => client.getShell<{ threads: ShellThread[] }>(), { home, ttl: "1m", timeoutMs: t3CallMs, runCli: t3CliRunner({ timeoutMs: t3CallMs }) });

export const hookWith = (shell: (home: string) => ReadShell): Hook => async (_provider, readInput, home) => {
  try {
    const event = JSON.parse(await readInput()) as StopEvent & SendEvent;
    if (event.tool_name !== undefined) return printing(await guardSend(event, { home, shell: shell(home) }));
    return printing(await guardStop(event, home));
  } catch {
    return printing(undefined);
  }
};

export const hook = hookWith(liveShell);

if (import.meta.main) await runHook(hook);
