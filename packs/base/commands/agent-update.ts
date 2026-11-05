import { join } from "node:path";

export type Run = (command: string[]) => Promise<{ code: number; out: string }>;

export const codexInstaller = join(import.meta.dir, "../lib/install-codex.sh");

const updates: Array<{ name: string; installed: string[]; marker: string; update: string[] }> = [
  { name: "Claude Code", installed: ["sh", "-c", 'test -x "$HOME/.local/bin/claude" && echo native'], marker: "native", update: ["claude", "update"] },
  { name: "Codex", installed: ["sh", "-c", 'readlink "$HOME/.local/bin/codex"'], marker: "/.local/share/fleet/codex/", update: ["sh", codexInstaller] },
  { name: "Codex from Bun", installed: ["bun", "pm", "ls", "-g"], marker: "@openai/codex", update: ["bun", "add", "-g", "@openai/codex@latest"] },
];

/** Updates each agent CLI that Fleet installed and skips the others. Returns the lines to print and whether every update worked. */
export async function updateAgents(run: Run): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  for (const agent of updates) {
    const found = await run(agent.installed);
    if (found.code !== 0 || !found.out.includes(agent.marker)) {
      lines.push(`${agent.name}: not installed by Fleet, skipped.`);
      continue;
    }
    const result = await run(agent.update);
    ok &&= result.code === 0;
    lines.push(`${agent.name}: ${result.code === 0 ? "up to date" : `update failed (exit ${result.code})`}.`);
  }
  return { ok, lines };
}

async function runCommand(command: string[]) {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, out };
  } catch {
    return { code: 127, out: "" };
  }
}

if (import.meta.main) {
  const { ok, lines } = await updateAgents(runCommand);
  for (const line of lines) console.log(line);
  process.exit(ok ? 0 : 1);
}
