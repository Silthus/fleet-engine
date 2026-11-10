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

const uncheckedReason = (error: unknown, person: string) => `Fleet blocked this call: the shell guards could not check it (${error instanceof Error ? error.message : String(error)}). `
  + `Split it into simpler commands, or stop and ask ${person}.`;

function check(call: ToolCall, person: string): string | undefined {
  if (call.tool_name !== "Bash") return undefined;
  return downloadRisk(shellCommand(call.tool_input), call.cwd ?? "/", person);
}

/** The refusal for a tool call that a shell guard stops, naming the person the settings give. A call the guards cannot
 * check is refused too. */
export function guard(call: ToolCall, home: string): Denial | undefined {
  const { person } = guardSettings(home);
  try {
    const risk = check(call, person);
    return risk ? deny(risk) : undefined;
  } catch (error) {
    return deny(uncheckedReason(error, person));
  }
}

function answer(input: string, home: string): Denial | undefined {
  let call: ToolCall;
  try {
    call = JSON.parse(input);
  } catch {
    return deny(uncheckedReason(new Error("the hook input is not JSON"), guardSettings(home).person));
  }
  return guard(call, home);
}

if (import.meta.main) {
  const denial = answer(await Bun.stdin.text(), process.env.HOME ?? homedir());
  if (denial) process.stdout.write(`${JSON.stringify(denial)}\n`);
}
