import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Hook, printing, runHook } from "../../base/lib/hook.ts";
import type { ShellThread } from "../../base/lib/t3/index.ts";
import { runGh } from "../lib/gh.ts";
import { isOrganize, prState, readHandovers, readT3Threads, settleRefusal, settleTarget } from "../lib/pr-owners.ts";

type ToolCall = { tool_name?: string; tool_input?: Record<string, unknown> };
export type SettleDeps = { threads: (home: string, environmentId?: string) => Promise<ShellThread[] | undefined>; prState: (url: string) => Promise<string>; self?: string };

const fallbackPerson = "the person who runs this machine";
const noAnswer = "Fleet blocked this settle: T3 did not answer; retry, or settle in the T3 UI.";
const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

export function personName(home: string): string {
  try {
    const file = join(home, ".local/state/fleet/settings.json");
    const person = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)["guards.person"] : undefined;
    return typeof person === "string" && person.trim() ? person.trim() : fallbackPerson;
  } catch {
    return fallbackPerson;
  }
}

export async function guardSettle(call: ToolCall, home: string, deps: SettleDeps) {
  if (!isOrganize(call.tool_name)) return undefined;
  const input = call.tool_input ?? {};
  const id = settleTarget(input, deps.self);
  if (!id) return undefined;
  const machine = typeof input.environmentId === "string" && input.environmentId ? input.environmentId : undefined;
  const threads = await deps.threads(home, machine).catch(() => undefined);
  if (!threads) return deny(noAnswer);
  const reason = await settleRefusal(id, { threads, handovers: () => readHandovers(home), prState: deps.prState }, personName(home));
  return reason ? deny(reason) : undefined;
}

export const hook: Hook = async (_provider, readInput, home) => {
  const call = await readInput().then((text) => JSON.parse(text) as ToolCall).catch((): ToolCall => ({}));
  return printing(await guardSettle(call, home, { threads: readT3Threads, prState: (url) => prState(runGh, url), self: process.env.T3CODE_THREAD_ID }));
};

if (import.meta.main) await runHook(hook);
