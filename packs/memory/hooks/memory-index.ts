import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { answerHook, clip, type HookInput, logShown, memoryRoot, type Provider, repoIndexPath, repoOf } from "../lib/notes.ts";

const indexLimit = 16_000;

function header(path: string) {
  const folder = dirname(path) === "." ? "" : `${dirname(path)}/`;
  return `Shared memory index ${path}. Its links are relative to ~/.agents/memory/${folder}. Open a memory before you act on its topic.`;
}

export function sessionIndexes(input: HookInput, provider: Provider, home: string): string | undefined {
  const session = input.session_id;
  const root = memoryRoot(home);
  if (!session || input.source === "resume" || !existsSync(join(root, "MEMORY.md"))) return undefined;
  const repo = repoOf(input.cwd ?? process.cwd());
  const indexes = [...(provider === "codex" ? ["MEMORY.md"] : []), ...(repo ? [repoIndexPath(repo)] : [])].filter((path) => existsSync(join(root, path)));
  const parts = indexes.map((path) => {
    logShown(home, { session, agent: input.agent_id, via: "index", note: path });
    return `${header(path)}\n\n${clip(readFileSync(join(root, path), "utf8").trim(), indexLimit)}`;
  });
  return parts.length ? parts.join("\n\n") : undefined;
}

if (import.meta.main) await answerHook("SessionStart", (input, provider) => sessionIndexes(input, provider, process.env.HOME ?? homedir()));
