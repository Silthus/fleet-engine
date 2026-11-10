import { readFileSync } from "node:fs";

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
type TranscriptEntry = { type?: string; message?: { content?: unknown } };
export type StatusCall = { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string; transcript_path?: string };

const longestAllowedPause = 10;

export const sleepPollReason = (person: string) => "Fleet blocked this command: a `sleep` and then a check costs a model turn each time it repeats, "
  + "and every turn reads the whole context again. Wait in one command that blocks until the event: "
  + "`gh run watch <id> --exit-status`, `gh pr checks <number> --watch`, or `until <check>; do sleep 30; done` with a timeout. "
  + "To monitor a pull request in T3 Code, call `watch_pull_request` and end the turn. Pauses of up to 10 seconds are allowed. "
  + `If nothing can wait for this event in one call, stop and ask ${person}.`;

export const repeatedStatusReason = (person: string) => "Fleet blocked this call: you already checked this task since this thread last woke. "
  + "T3 wakes this thread when the task ends, so end the turn. "
  + "If this turn needs the result now, call `t3_thread_wait` on the task's child thread with a long `timeoutMs`. "
  + `If the task looks stuck, stop and ask ${person}.`;

/** A pause longer than 10 seconds outside a loop that waits in one command: a poll that costs a turn per check. */
export function isSleepPoll(command: string): boolean {
  const pauses = [...command.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  const waitsInOneCommand = /\b(until|while|for)\b/.test(command);
  return !waitsInOneCommand && pauses.some((seconds) => seconds > longestAllowedPause);
}

export const isTaskStatus = (name = "") => /^mcp__t3[-_]code__task_status$/.test(name);

const onlyToolResults = (content: unknown) =>
  Array.isArray(content) && content.length > 0 && content.every((block: Block) => block?.type === "tool_result");

function parse(line: string): TranscriptEntry | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function transcriptLines(path: string) {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").reverse();
  } catch {
    return [];
  }
}

/** Whether this thread already checked the same task since a person or a wake last wrote to it. */
export function repeatsTaskStatus(call: StatusCall): boolean {
  if (!call.transcript_path) return false;
  const taskId = call.tool_input?.taskId;
  for (const entry of transcriptLines(call.transcript_path).map(parse)) {
    const content = entry?.message?.content;
    if (entry?.type === "user" && !onlyToolResults(content)) return false;
    if (entry?.type !== "assistant" || !Array.isArray(content)) continue;
    const earlierCheck = content.some((block: Block) =>
      block.type === "tool_use" && block.id !== call.tool_use_id && isTaskStatus(block.name) && block.input?.taskId === taskId);
    if (earlierCheck) return true;
  }
  return false;
}
