import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { commandsIn } from "./shell-words.ts";

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
type TranscriptEntry = { type?: string; message?: { content?: unknown } };
export type StatusCall = { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string; transcript_path?: string };

const longestAllowedPause = 10;
const chunkSize = 64 * 1024;
const unitSeconds: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

export const sleepPollReason = (person: string) => "Fleet blocked this command: a `sleep` and then a check costs a model turn each time it repeats, "
  + "and every turn reads the whole context again. Wait in one command that blocks until the event: "
  + "`gh run watch <id> --exit-status`, `gh pr checks <number> --watch`, or `until <check>; do sleep 30; done` with a timeout. "
  + "To monitor a pull request in T3 Code, call `watch_pull_request` and end the turn. Pauses of up to 10 seconds are allowed. "
  + `If nothing can wait for this event in one call, stop and ask ${person}.`;

export const repeatedStatusReason = (person: string) => "Fleet blocked this call: you already checked this task since this thread last woke. "
  + "T3 wakes this thread when the task ends, so end the turn. "
  + "If this turn needs the result now, call `t3_thread_wait` on the task's child thread with a long `timeoutMs`. "
  + `If the task looks stuck, stop and ask ${person}.`;

function seconds(operand: string): number {
  if (operand.toLowerCase() === "infinity") return Infinity;
  const match = operand.match(/^((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([smhd]?)$/i);
  return match ? Number(match[1]) * unitSeconds[match[2].toLowerCase()] : 0;
}

const pauseSeconds = (args: string[]) => args.reduce((total, operand) => total + seconds(operand), 0);

/** A `sleep` command longer than 10 seconds outside a loop that waits in one command: a poll that costs a turn per check. */
export const isSleepPoll = (command: string) =>
  commandsIn(command).some((pause) => pause.name === "sleep" && !pause.inLoop && pauseSeconds(pause.args) > longestAllowedPause);

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

function* linesFromEnd(path: string): Generator<string> {
  const file = openSync(path, "r");
  try {
    let position = fstatSync(file).size;
    let tail: Buffer[] = [];
    while (position > 0) {
      const size = Math.min(chunkSize, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      readSync(file, chunk, 0, size, position);
      let end = size;
      for (let newline = chunk.lastIndexOf(10, end - 1); newline >= 0; newline = end > 0 ? chunk.lastIndexOf(10, end - 1) : -1) {
        yield Buffer.concat([chunk.subarray(newline + 1, end), ...tail]).toString("utf8");
        tail = [];
        end = newline;
      }
      tail.unshift(chunk.subarray(0, end));
    }
    yield Buffer.concat(tail).toString("utf8");
  } finally {
    closeSync(file);
  }
}

function* transcriptEntries(path: string): Generator<TranscriptEntry | undefined> {
  try {
    for (const line of linesFromEnd(path)) yield parse(line);
  } catch {
    return;
  }
}

/** Whether this thread already checked the same task since a person or a wake last wrote to it. */
export function repeatsTaskStatus(call: StatusCall): boolean {
  if (!call.transcript_path) return false;
  const taskId = call.tool_input?.taskId;
  for (const entry of transcriptEntries(call.transcript_path)) {
    const content = entry?.message?.content;
    if (entry?.type === "user" && !onlyToolResults(content)) return false;
    if (entry?.type !== "assistant" || !Array.isArray(content)) continue;
    const earlierCheck = content.some((block: Block) =>
      block.type === "tool_use" && block.id !== call.tool_use_id && isTaskStatus(block.name) && block.input?.taskId === taskId);
    if (earlierCheck) return true;
  }
  return false;
}
