import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installedOwners } from "../lib/allowlist.ts";
import { downloadRisk } from "../lib/download.ts";
import { ghRisk, ownerList } from "../lib/gh.ts";
import { isSleepPoll, isTaskStatus, repeatedStatusReason, repeatsTaskStatus, sleepPollReason } from "../lib/wait.ts";

export type ToolCall = { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string; tool_use_id?: string; transcript_path?: string };
export type Denial = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };

const fallbackPerson = "the person who runs this machine";

type Settings = { person: string; owners: Set<string> | null; unreadable?: string };

function guardSettings(home: string): Settings {
  const file = join(home, ".local/state/fleet/settings.json");
  if (!existsSync(file)) return { person: fallbackPerson, owners: null };
  try {
    const settings: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error("it is not a JSON object");
    const { "guards.person": person, "guards.owners": owners } = settings as Record<string, unknown>;
    if (owners !== undefined && owners !== null && typeof owners !== "string") throw new Error("guards.owners is not text");
    return { person: typeof person === "string" && person.trim() ? person.trim() : fallbackPerson, owners: ownerList(owners) };
  } catch (error) {
    return { person: fallbackPerson, owners: null, unreadable: `${file} (${error instanceof Error ? error.message : String(error)})` };
  }
}

function shellCommand(input: Record<string, unknown> = {}) {
  const command = input.command ?? input.cmd;
  if (Array.isArray(command)) return /(?:^|\/)(?:ba)?sh$/.test(String(command[0])) && /^-l?c$/.test(String(command[1])) ? String(command[2] ?? "") : command.join(" ");
  return typeof command === "string" ? command : "";
}

const deny = (reason: string): Denial => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

const unreadableReason = (problem: string, person: string) => `Fleet blocked this call: the shell guards could not read their settings in ${problem}, `
  + `so they cannot tell which GitHub owners agents may use. Fix that file, or stop and ask ${person}.`;

const uncheckedReason = (error: unknown, person: string) => `Fleet blocked this call: the shell guards could not check it (${error instanceof Error ? error.message : String(error)}). `
  + `Split it into simpler commands, or stop and ask ${person}.`;

function check(call: ToolCall, { person, owners, unreadable }: Settings): string | undefined {
  if (isTaskStatus(call.tool_name)) return repeatsTaskStatus(call) ? repeatedStatusReason(person) : undefined;
  if (call.tool_name !== "Bash") return undefined;
  if (unreadable) return unreadableReason(unreadable, person);
  const command = shellCommand(call.tool_input);
  return downloadRisk(command, call.cwd ?? "/", person) ?? ghRisk(command, owners, person, process.env.GH_REPO) ?? (isSleepPoll(command) ? sleepPollReason(person) : undefined);
}

/** The refusal for a tool call that a shell guard stops, naming the person the settings give. A call the guards cannot
 * check is refused too. An installed signed allowlist under the system root wins over guards.owners. */
export function guard(call: ToolCall, home: string, root = "/"): Denial | undefined {
  const settings = guardSettings(home);
  try {
    const risk = check(call, { ...settings, owners: installedOwners(root) ?? settings.owners });
    return risk ? deny(risk) : undefined;
  } catch (error) {
    return deny(uncheckedReason(error, settings.person));
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
