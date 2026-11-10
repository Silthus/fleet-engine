import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./secret-guard.ts";

export type HookResult = { code: number; stdout: string; stderr: string };
export type RunHook = (path: string, provider: string, input: string) => Promise<HookResult>;

type Specific = { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string; [key: string]: unknown };
type Decision = { decision?: string; reason?: string; hookSpecificOutput?: Specific };

const strictness = ["allow", "ask", "deny"];

/**
 * Runs every hook in name order and picks one answer. A JSON block wins, then an exit-2 block, then a
 * JSON answer with hook-specific output, then the first other output. Every hook's hook-specific output
 * is merged into one: the strictest permission decision wins (deny, then ask, then allow), the contexts
 * are joined, and any other field keeps its first value, so another hook can never undo the secret guard.
 * A deny drops any rewritten input, a block turns a tool call's answer into a deny, and prompt suppression
 * stays on once any hook asks for it. A permission request's deny wins over its allow. Codex cannot ask the
 * person, so an ask becomes a deny there. The joined context is redacted, so no hook can echo a secret back.
 * A failing hook only reports.
 */
export async function dispatch(dir: string, provider: string, input: string, run: RunHook = runWithBun): Promise<HookResult> {
  const results: Array<HookResult & { name: string; json?: Decision }> = [];
  for (const name of listHooks(dir)) {
    const result = await run(join(dir, name), provider, input);
    results.push({ ...result, name, json: result.code === 0 ? parseDecision(result.stdout) : undefined });
  }
  const problems = results.filter((result) => result.code !== 0 && result.code !== 2).map((result) => `fleet hook ${result.name}: ${result.stderr.trim() || `exit ${result.code}`}\n`).join("");
  const blockJson = results.find((result) => result.json?.decision === "block")?.json;
  const protect = mergeSpecific(provider, results.flatMap((result) => (result.json?.hookSpecificOutput ? [result.json.hookSpecificOutput] : [])));
  const blocked = results.find((result) => result.code === 2);
  const answer = (decision: Decision): HookResult => ({ code: 0, stdout: `${JSON.stringify(decision)}\n`, stderr: problems });
  if (blockJson) return answer({ ...blockJson, hookSpecificOutput: denying(protect, blockJson.reason ?? "") });
  if (blocked && protect) return answer({ decision: "block", reason: blocked.stderr.trim(), hookSpecificOutput: denying(protect, blocked.stderr.trim()) });
  if (blocked) return { code: 2, stdout: "", stderr: problems + blocked.stderr };
  if (protect) return answer({ ...results.find((result) => result.json?.hookSpecificOutput)!.json, hookSpecificOutput: protect });
  const first = results.find((result) => result.code === 0 && result.stdout.trim());
  return { code: first || !problems ? 0 : 1, stdout: first?.stdout ?? "", stderr: problems };
}

const permissionVerdict = (output: Specific) => (typeof output.decision === "object" && output.decision !== null ? (output.decision as { behavior?: unknown }) : undefined);

function mergeSpecific(provider: string, outputs: Specific[]): Specific | undefined {
  if (outputs.length === 0) return undefined;
  const merged: Specific = Object.assign({}, ...[...outputs].reverse());
  const decided = outputs.filter((output) => strictness.includes(output.permissionDecision ?? ""));
  const strictest = decided.reduce<Specific | undefined>((best, output) => (!best || strictness.indexOf(output.permissionDecision!) > strictness.indexOf(best.permissionDecision!) ? output : best), undefined);
  if (strictest) {
    merged.permissionDecision = strictest.permissionDecision;
    merged.permissionDecisionReason = strictest.permissionDecisionReason;
  }
  if (provider === "codex" && merged.permissionDecision === "ask") {
    merged.permissionDecision = "deny";
    merged.permissionDecisionReason = `This call needs the person's approval, and Codex cannot ask for it here. ${merged.permissionDecisionReason ?? ""}`.trim();
  }
  if (merged.permissionDecision === "deny") delete merged.updatedInput;
  const verdicts = outputs.map(permissionVerdict).filter((verdict) => verdict?.behavior === "allow" || verdict?.behavior === "deny");
  const verdict = verdicts.find((item) => item?.behavior === "deny") ?? verdicts[0];
  if (verdict) merged.decision = verdict;
  if (outputs.some((output) => output.suppressOriginalPrompt === true)) merged.suppressOriginalPrompt = true;
  const contexts = outputs.map((output) => output.additionalContext).filter((context): context is string => typeof context === "string" && context.length > 0);
  if (contexts.length > 0) merged.additionalContext = redactSecrets(contexts.join("\n\n"));
  return merged;
}

function denying(specific: Specific | undefined, reason: string): Specific | undefined {
  if (!specific || (specific.hookEventName !== "PreToolUse" && specific.permissionDecision === undefined)) return specific;
  const kept = specific.permissionDecision === "deny" ? specific.permissionDecisionReason?.trim() : undefined;
  const denied: Specific = { ...specific, permissionDecision: "deny", permissionDecisionReason: reason.trim() || kept || "A Fleet hook blocked this tool call." };
  delete denied.updatedInput;
  return denied;
}

function parseDecision(stdout: string): Decision | undefined {
  try {
    const value = JSON.parse(stdout);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function listHooks(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function runWithBun(path: string, provider: string, input: string): Promise<HookResult> {
  const child = Bun.spawn([process.execPath, path, provider], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

if (import.meta.main) {
  const [provider, event] = process.argv.slice(2);
  if ((provider !== "claude" && provider !== "codex") || !event || !/^[A-Za-z]+$/.test(event)) {
    process.stderr.write("Usage: run.sh claude|codex <event>\n");
    process.exit(1);
  }
  const result = await dispatch(join(process.env.HOME ?? homedir(), ".config/fleet/hooks", event), provider, await Bun.stdin.text());
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
