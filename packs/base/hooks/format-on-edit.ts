import { isAbsolute } from "node:path";
import { blocking, type Hook, quiet, runHook } from "../lib/hook.ts";
import { formatEditedFile, type RunCommand } from "../lib/format-commands.ts";

export const budgetMs = 75_000;
const commandNotFound = 127;
const shownLines = 40;
const editTools = /^(Edit|MultiEdit|Write)$/;

type EditEvent = { tool_name?: string; tool_input?: Record<string, unknown> };

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

export async function formatAfterEdit(event: EditEvent, run: RunCommand = runCommand): Promise<string | undefined> {
  const file = event.tool_input?.file_path;
  if (!editTools.test(event.tool_name ?? "") || typeof file !== "string" || !isAbsolute(file)) return undefined;
  const findings = await formatEditedFile(file, run, budgetMs);
  return findings.length ? `The repository's lint-staged checks found problems in ${file}. Fix them before you commit:\n\n${findings.join("\n\n")}` : undefined;
}

export const hook: Hook = async (provider, readInput) => {
  if (provider !== "claude") return quiet;
  try {
    return blocking(await formatAfterEdit(JSON.parse(await readInput()) as EditEvent));
  } catch {
    return quiet;
  }
};

if (import.meta.main) await runHook(hook);
