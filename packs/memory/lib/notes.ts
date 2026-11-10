import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type Provider = "claude" | "codex";
export type HookInput = { session_id?: string; agent_id?: string; cwd?: string; source?: string; tool_name?: string; tool_input?: unknown };
export type Shown = { at: string; event: "memoryShown"; session: string; agent?: string; via: "index" | "trigger"; note: string; trigger?: string };

export const memoryRoot = (home: string) => join(home, ".agents/memory");
export const stateDir = (home: string) => join(home, ".local/state/fleet/memory");
export const repoIndexPath = (repo: string) => `projects/${repo}/INDEX.md`;

const shownFile = (home: string, session: string) => join(stateDir(home), "shown", `${session.replace(/[^\w-]/g, "")}.jsonl`);

function gitOutput(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

export function repoOf(cwd: string): string | undefined {
  if (!existsSync(cwd)) return undefined;
  const origin = gitOutput(cwd, ["remote", "get-url", "origin"]);
  if (origin) return origin.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || undefined;
  const common = gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common ? basename(dirname(common)) : undefined;
}

export function logShown(home: string, shown: Omit<Shown, "at" | "event">) {
  mkdirSync(join(stateDir(home), "shown"), { recursive: true, mode: 0o700 });
  appendFileSync(shownFile(home, shown.session), `${JSON.stringify({ at: new Date().toISOString(), event: "memoryShown", ...shown })}\n`, { mode: 0o600 });
}

export function claimNote(home: string, session: string, agent: string | undefined, note: string) {
  const dir = join(stateDir(home), "claimed");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(JSON.stringify([session, agent ?? "", note])).digest("hex");
  try {
    closeSync(openSync(join(dir, key), "wx", 0o600));
    return true;
  } catch {
    return false;
  }
}

export function clip(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[… open the file for the rest]`;
}

export async function answerHook(event: string, answer: (input: HookInput, provider: Provider) => string | undefined) {
  try {
    const provider = process.argv[2];
    if (provider !== "claude" && provider !== "codex") return;
    const context = answer(JSON.parse(await Bun.stdin.text()) as HookInput, provider);
    if (context) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })}\n`);
  } catch {
    return;
  }
}
