import { readFile } from "node:fs/promises";
import { type Hook, printing, runHook } from "../../base/lib/hook.ts";
import { findThread, withT3Session } from "../../base/lib/t3/index.ts";
import { asksForDecision, personName } from "../lib/prose-question.ts";

export type StopEvent = { transcript_path?: string; stop_hook_active?: boolean; last_assistant_message?: string };
export type StopBlock = { decision: "block"; reason: string };
export type IsTopLevel = (threadId: string | undefined, home: string) => Promise<boolean>;

type Line = { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown }; payload?: { type?: string; role?: string; content?: unknown } };
type Block = { type?: string; text?: string };

export const questionToolReason = (person: string) => `Fleet blocked this stop: your last message asks ${person} a decision in prose. `
  + "While a PR watch, a thread wait, or a Monitor is awaited, T3 keeps this thread under Working, so the question never reaches them. "
  + "Ask it now with the question tool (AskUserQuestion in Claude, request_user_input in Codex): restate the decision in full, with options. "
  + `A pending question brings the thread back to ${person} even while it watches. If you asked nothing, end the turn again.`;

const questionTool = /"name":\s*"[^"]*(AskUserQuestion|request_user_input)"|\brequest_user_input\s*\(/;

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

function assistantText(line: Line | undefined): string | undefined {
  const content = line?.type === "assistant" ? line.message?.content
    : line?.type === "response_item" && line.payload?.type === "message" && line.payload.role === "assistant" ? line.payload.content : undefined;
  if (typeof content === "string") return content || undefined;
  if (!Array.isArray(content)) return undefined;
  return content.filter((block: Block) => block?.type === "text" || block?.type === "output_text").map((block: Block) => block.text).join("\n") || undefined;
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
  if (turn.some((line) => questionTool.test(line))) return undefined;
  const last = event.last_assistant_message ?? turn.map((line) => assistantText(parse(line))).filter(Boolean).at(-1);
  if (!last || !asksForDecision(last)) return undefined;
  if (!(await topLevel(threadId, home))) return undefined;
  return { decision: "block", reason: questionToolReason(personName(home)) };
}

export const hook: Hook = async (_provider, readInput, home) => {
  try {
    return printing(await guardStop(JSON.parse(await readInput()) as StopEvent, home));
  } catch {
    return printing(undefined);
  }
};

if (import.meta.main) await runHook(hook);
