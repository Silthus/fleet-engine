import { isAbsolute } from "node:path";
import { type Hook, printing, quiet, runHook } from "../lib/hook.ts";
import { formatEditedFile, type RunCommand } from "../lib/format-commands.ts";
import { type ToolEvent, writtenFiles } from "../lib/written-files.ts";

export const budgetMs = 75_000;
const commandNotFound = 127;
const shownLines = 40;

export const runCommand: RunCommand = async (command, cwd, timeoutMs) => {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
  } catch {
    return undefined;
  }
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
  if (code === 0 || code === commandNotFound || child.signalCode) return undefined;
  const output = `${stdout}${stderr}`.trim().split("\n");
  if (output.some((line) => /: (command )?not found$/.test(line))) return undefined;
  return `\`${command.join(" ")}\` failed:\n${output.slice(-shownLines).join("\n")}`;
};

export async function formatAfterEdit(event: ToolEvent, run: RunCommand = runCommand, now: () => number = Date.now): Promise<string | undefined> {
  const deadline = now() + budgetMs;
  const problems: string[] = [];
  for (const file of writtenFiles(event).filter((path) => isAbsolute(path))) {
    const left = deadline - now();
    if (left <= 0) break;
    const findings = await formatEditedFile(file, run, left).catch(() => []);
    if (findings.length) problems.push(`The repository's lint-staged checks found problems in ${file}. Fix them before you commit:\n\n${findings.join("\n\n")}`);
  }
  return problems.length ? problems.join("\n\n") : undefined;
}

export const hook: Hook = async (_provider, readInput) => {
  try {
    const context = await formatAfterEdit(JSON.parse(await readInput()) as ToolEvent);
    return printing(context ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } } : undefined);
  } catch {
    return quiet;
  }
};

if (import.meta.main) await runHook(hook);
