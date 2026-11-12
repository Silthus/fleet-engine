import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Hook, printing, quiet, runHook } from "../../base/lib/hook.ts";
import { cacheFile, readPointer, stateDir } from "../lib/config.ts";
import { readLibrary, related } from "../lib/library.ts";

type PromptInput = { session_id?: string; agent_id?: string; prompt?: string };

const day = 86_400_000;
const shownDir = (home: string) => join(stateDir(home), "shown");

function forgetIdleSessions(home: string, now: number) {
  let sessions: string[];
  try {
    sessions = readdirSync(shownDir(home));
  } catch {
    return;
  }
  for (const session of sessions) {
    const dir = join(shownDir(home), session);
    try {
      if (now - statSync(dir).mtimeMs > day) rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

function claim(home: string, session: string, agent: string | undefined, path: string) {
  const dir = join(shownDir(home), session.replace(/[^\w-]/g, ""));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(join(dir, createHash("sha256").update(JSON.stringify([agent ?? "", path])).digest("hex")), "wx", 0o600));
    return true;
  } catch {
    return false;
  }
}

export function relatedContext(input: PromptInput, home: string): string | undefined {
  const library = readPointer(home);
  if (!library || !input.session_id || !input.prompt?.trim()) return undefined;
  forgetIdleSessions(home, Date.now());
  const docs = related(readLibrary(library.path, cacheFile(home)), input.prompt).filter((doc) => claim(home, input.session_id!, input.agent_id, doc.path));
  if (!docs.length) return undefined;
  const whose = library.owner ? `${library.owner}'s` : "your";
  const lines = docs.map((doc) => `- ${join(library.path, doc.path)}: ${doc.title}${[doc.type, doc.date].filter(Boolean).length ? ` (${[doc.type, doc.date].filter(Boolean).join(", ")})` : ""}`);
  return [`Related context from ${whose} library, matched on this prompt. Open a document before you act on its topic; \`fleet context search <words>\` finds more.`, ...lines].join("\n");
}

export const hook: Hook = async (provider, readInput, home) => {
  if (provider !== "claude" && provider !== "codex") return quiet;
  try {
    const context = relatedContext(JSON.parse(await readInput()) as PromptInput, home);
    return printing(context ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } } : undefined);
  } catch {
    return quiet;
  }
};

if (import.meta.main) await runHook(hook);
