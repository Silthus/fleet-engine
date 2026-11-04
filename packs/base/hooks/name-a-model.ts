export const reminder = "Name a model on this Agent call, cast with the model table in ~/.agents/AGENTS.md. An omitted model inherits the parent model.";

type ToolEvent = { tool_name?: string; tool_input?: { model?: unknown } };

/** Returns the reminder when a Claude subagent call names no model. */
export function check(provider: string, event: ToolEvent): string | undefined {
  if (provider !== "claude" || !/^(Agent|Task)$/.test(event.tool_name ?? "")) return undefined;
  return event.tool_input?.model ? undefined : reminder;
}

if (import.meta.main) {
  const problem = check(process.argv[2] ?? "", JSON.parse(await Bun.stdin.text()) as ToolEvent);
  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exit(2);
  }
}
