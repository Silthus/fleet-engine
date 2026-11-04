import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HookResult = { code: number; stdout: string; stderr: string };
export type RunHook = (path: string, provider: string, input: string) => Promise<HookResult>;

/**
 * Runs each hook in name order. The first hook that blocks (exit 2) wins. Otherwise the first
 * hook that prints a decision wins, and a hook that fails only reports, so it never hides a decision.
 */
export async function dispatch(dir: string, provider: string, input: string, run: RunHook = runWithBun): Promise<HookResult> {
  const hooks = listHooks(dir);
  let decision = "";
  const problems: string[] = [];
  for (const name of hooks) {
    const result = await run(join(dir, name), provider, input);
    if (result.code === 2) return { code: 2, stdout: "", stderr: result.stderr };
    if (result.code !== 0) problems.push(`${name}: ${result.stderr.trim() || `exit ${result.code}`}`);
    else if (!decision && result.stdout.trim()) decision = result.stdout;
  }
  return { code: decision || !problems.length ? 0 : 1, stdout: decision, stderr: problems.map((line) => `fleet hook ${line}\n`).join("") };
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
