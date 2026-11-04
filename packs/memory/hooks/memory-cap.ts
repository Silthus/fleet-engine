import { existsSync, readFileSync } from "node:fs";

export const indexLimit = 180;

type ToolCall = { tool_name?: string; tool_input?: { file_path?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean } };

/** The line count MEMORY.md would have after this write or edit, or undefined when the call does not write a MEMORY.md. */
export function linesAfter(call: ToolCall): number | undefined {
  const input = call.tool_input ?? {};
  if (!input.file_path?.endsWith("/MEMORY.md")) return undefined;
  if (call.tool_name === "Write") return lineCount(input.content ?? "");
  if (call.tool_name !== "Edit" || input.old_string === undefined || input.new_string === undefined) return undefined;
  const before = existsSync(input.file_path) ? readFileSync(input.file_path, "utf8") : "";
  const after = input.replace_all ? before.split(input.old_string).join(input.new_string) : before.replace(input.old_string, () => input.new_string!);
  return lineCount(after);
}

export function check(call: ToolCall): string | undefined {
  const lines = linesAfter(call);
  if (lines === undefined || lines <= indexLimit) return undefined;
  return `${call.tool_input!.file_path} would have ${lines} lines. Claude Code loads only the first 200 lines of MEMORY.md, so later notes never load. Fold related notes into topic files and keep the index at ${indexLimit} lines or fewer.`;
}

function lineCount(text: string) {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

if (import.meta.main) {
  if (process.argv[2] !== "claude") process.exit(0);
  const reason = check(JSON.parse(await Bun.stdin.text()) as ToolCall);
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exit(2);
  }
}
