import { isAbsolute, resolve } from "node:path";

export type ToolEvent = { tool_name?: string; tool_input?: unknown; cwd?: string };

const editTools = /^(Edit|MultiEdit|Write)$/;

const stringsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(stringsOf) : [];

function patchedFiles(patch: string): string[] {
  const files: string[] = [];
  for (const [, verb, path] of patch.matchAll(/^\*\*\* (Add File|Update File|Move to): (.+)$/gm)) {
    if (verb === "Move to") files.pop();
    files.push(path!.trim());
  }
  return files;
}

export function writtenFiles(event: ToolEvent): string[] {
  const input = event.tool_input as { file_path?: unknown } | undefined;
  const paths = editTools.test(event.tool_name ?? "")
    ? typeof input?.file_path === "string" ? [input.file_path] : []
    : event.tool_name === "apply_patch" ? stringsOf(event.tool_input).flatMap(patchedFiles) : [];
  return [...new Set(paths.map((path) => event.cwd && isAbsolute(event.cwd) ? resolve(event.cwd, path) : path))];
}
