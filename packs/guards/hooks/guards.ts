import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { downloadRisk } from "../lib/download.ts";

export type Provider = "claude" | "codex";
export type ToolCall = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
export type Denial = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };

const fallbackPerson = "the person who runs this machine";

function guardSettings(home: string) {
  try {
    const settings = JSON.parse(readFileSync(join(home, ".local/state/fleet/settings.json"), "utf8"));
    const person = settings["guards.person"];
    return { person: typeof person === "string" && person.trim() ? person.trim() : fallbackPerson };
  } catch {
    return { person: fallbackPerson };
  }
}

function shellCommand(input: Record<string, unknown> = {}) {
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) return /(?:^|\/)(?:ba)?sh$/.test(String(command[0])) && /^-l?c$/.test(String(command[1])) ? String(command[2] ?? "") : command.join(" ");
  return typeof command === "string" ? command : "";
}

const deny = (reason: string): Denial => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

/** The refusal for a tool call that a shell guard stops, naming the person the settings give. */
export function guard(call: ToolCall, home: string): Denial | undefined {
  if (call.tool_name !== "Bash") return undefined;
  const { person } = guardSettings(home);
  const risk = downloadRisk(shellCommand(call.tool_input), call.cwd ?? "/", person);
  return risk ? deny(risk) : undefined;
}

if (import.meta.main) {
  const denial = guard(JSON.parse(await Bun.stdin.text()) as ToolCall, process.env.HOME ?? homedir());
  if (denial) process.stdout.write(`${JSON.stringify(denial)}\n`);
}
