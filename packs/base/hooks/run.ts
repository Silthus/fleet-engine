import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HookResult = { code: number; stdout: string; stderr: string };
export type RunHook = (path: string, provider: string, input: string) => Promise<HookResult>;

type Decision = { decision?: string; reason?: string; hookSpecificOutput?: unknown };

/**
 * Runs every hook in name order and picks one answer. A JSON block wins, then an exit-2 block, then a
 * JSON answer that redacts or suppresses, then the first other output. A block keeps the first
 * redaction or suppression, so another hook can never undo the secret guard. A failing hook only reports.
 */
export async function dispatch(dir: string, provider: string, input: string, run: RunHook = runWithBun): Promise<HookResult> {
  const results: Array<HookResult & { name: string; json?: Decision }> = [];
  for (const name of listHooks(dir)) {
    const result = await run(join(dir, name), provider, input);
    results.push({ ...result, name, json: result.code === 0 ? parseDecision(result.stdout) : undefined });
  }
  const problems = results.filter((result) => result.code !== 0 && result.code !== 2).map((result) => `fleet hook ${result.name}: ${result.stderr.trim() || `exit ${result.code}`}\n`).join("");
  const blockJson = results.find((result) => result.json?.decision === "block")?.json;
  const protect = results.find((result) => result.json?.hookSpecificOutput)?.json?.hookSpecificOutput;
  const blocked = results.find((result) => result.code === 2);
  const answer = (decision: Decision): HookResult => ({ code: 0, stdout: `${JSON.stringify(decision)}\n`, stderr: problems });
  if (blockJson) return answer({ ...blockJson, hookSpecificOutput: blockJson.hookSpecificOutput ?? protect });
  if (blocked && protect) return answer({ decision: "block", reason: blocked.stderr.trim(), hookSpecificOutput: protect });
  if (blocked) return { code: 2, stdout: "", stderr: problems + blocked.stderr };
  if (protect) return answer({ ...results.find((result) => result.json?.hookSpecificOutput)!.json });
  const first = results.find((result) => result.code === 0 && result.stdout.trim());
  return { code: first || !problems ? 0 : 1, stdout: first?.stdout ?? "", stderr: problems };
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
