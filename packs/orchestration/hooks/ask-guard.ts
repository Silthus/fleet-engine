import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Hook, printing, runHook } from "../../base/lib/hook.ts";
import { findThread, matchThread, questionCard, type ShellThread, t3CliRunner, t3UserData, withT3Session } from "../../base/lib/t3/index.ts";
import { proofStop, type ProofStopEvent, type ProofStopOptions } from "../lib/proof-stop.ts";
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

export async function finalMessage(event: StopEvent): Promise<string | undefined> {
  if (event.last_assistant_message !== undefined || !event.transcript_path) return event.last_assistant_message;
  try {
    return askedAfterLastMessage(currentTurn(await readFile(event.transcript_path, "utf8")), undefined).last;
  } catch {
    return undefined;
  }
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
export type SendGuardOptions = { home: string; shell: ReadShell };

export const pendingCardReason = (threadId: string, person: string) => `Fleet blocked this send: thread ${threadId} waits on a pending question card. `
  + `A send in mode auto, steer or restart interrupts its turn, and T3 cancels the card, so its lane asks ${person} again or the card is lost. `
  + `Send again with mode: "queue": the lane reads your message once ${person} answers. `
  + "Only when your message changes what the card asks, send the same message to the same thread once more to replace the card. A different message is denied again.";

export const killSwitch = ".config/fleet/ask-guard.off";

const isThreadSend = (name = "") => /^mcp__t3[-_]code__t3_thread_send$/.test(name);

const waitingCardKey = (thread: ShellThread | undefined) => thread?.activeRunId ? questionCard(thread) : undefined;

const interruptsTurn = (mode: unknown, freshContext: unknown) => mode !== "queue" && !(freshContext && (mode === "steer" || mode === "restart"));

async function isThisMachine(environmentId: unknown, home: string): Promise<boolean> {
  if (environmentId === undefined || environmentId === null || environmentId === "") return true;
  const here = await readFile(join(t3UserData(home), "environment-id"), "utf8").catch(() => "");
  return here.trim() === environmentId;
}

async function readThreads(shell: ReadShell): Promise<ShellThread[] | undefined> {
  try {
    return (await shell()).threads;
  } catch {
    return undefined;
  }
}

const denialLifetimeMs = 24 * 60 * 60 * 1000;

async function forgetOldDenials(denials: string): Promise<void> {
  const oldest = Date.now() - denialLifetimeMs;
  for (const record of await readdir(denials).catch(() => [])) {
    const path = join(denials, record);
    const written = (await stat(path).catch(() => undefined))?.mtimeMs;
    if (written !== undefined && written < oldest) await rm(path, { force: true }).catch(() => {});
  }
}

async function firstDenial(home: string, event: SendEvent, thread: string, card: string): Promise<boolean> {
  const denials = join(home, ".local/state/fleet/ask-guard");
  const message = typeof event.tool_input?.message === "string" ? event.tool_input.message : "";
  const key = createHash("sha256").update(JSON.stringify([event.session_id ?? "", event.agent_id ?? "", thread, card, message])).digest("hex").slice(0, 32);
  try {
    await mkdir(denials, { recursive: true });
    await writeFile(join(denials, key), "", { flag: "wx" });
  } catch {
    return false;
  }
  await forgetOldDenials(denials);
  return true;
}

export async function guardSend(event: SendEvent, options: SendGuardOptions): Promise<SendDenial | undefined> {
  const { threadId, mode, freshContext, environmentId } = event.tool_input ?? {};
  if (!isThreadSend(event.tool_name) || typeof threadId !== "string" || !interruptsTurn(mode, freshContext) || existsSync(join(options.home, killSwitch))) return undefined;
  if (!(await isThisMachine(environmentId, options.home))) return undefined;
  const threads = await readThreads(options.shell);
  if (!threads) return undefined;
  const target = matchThread(threads, threadId, (thread) => thread.id);
  const card = waitingCardKey(target);
  if (!target || !card || !(await firstDenial(options.home, event, target.id, card))) return undefined;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: pendingCardReason(threadId, personName(options.home)) } };
}

const t3CallMs = 3_000;

const liveShell = (home: string): ReadShell => () =>
  withT3Session((client) => client.getShell<{ threads: ShellThread[] }>(), { home, ttl: "1m", timeoutMs: t3CallMs, runCli: t3CliRunner({ timeoutMs: t3CallMs }) });

export type StopDeps = Partial<Pick<ProofStopOptions, "threadId" | "git" | "processes" | "deadline">> & { topLevel?: IsTopLevel };

async function guardStopAndProof(event: StopEvent & ProofStopEvent, home: string, shell: ReadShell, deps: StopDeps) {
  const threadId = "threadId" in deps ? deps.threadId : process.env.T3CODE_THREAD_ID;
  const prose = await guardStop(event, home, threadId, deps.topLevel).catch(() => undefined);
  if (prose || existsSync(join(home, killSwitch))) return prose;
  return proofStop({ ...event, last_assistant_message: await finalMessage(event) }, { home, shell, ...deps, threadId });
}

export const hookWith = (shell: (home: string) => ReadShell, stop: StopDeps = {}): Hook => async (_provider, readInput, home) => {
  try {
    const event = JSON.parse(await readInput()) as StopEvent & ProofStopEvent & SendEvent;
    if (event.tool_name !== undefined) return printing(await guardSend(event, { home, shell: shell(home) }));
    return printing(await guardStopAndProof(event, home, shell(home), stop));
  } catch {
    return printing(undefined);
  }
};

export const hook = hookWith(liveShell);

if (import.meta.main) await runHook(hook, { exitOnAnswer: true });
