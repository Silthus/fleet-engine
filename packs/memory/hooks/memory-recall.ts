import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { answerHook, clip, type HookInput, logShown, memoryRoot, readShown, repoOf } from "../lib/notes.ts";
import { names, readTriggers, stripFrontmatter } from "../lib/triggers.ts";

const notesPerCall = 2;
const noteLimit = 3000;

export function recallNotes(input: HookInput, home: string): string | undefined {
  const session = input.session_id;
  const root = memoryRoot(home);
  if (!session || !existsSync(join(root, "MEMORY.md"))) return undefined;
  const call = JSON.stringify({ tool: input.tool_name ?? "", input: input.tool_input ?? "" });
  if (call.includes(".agents/memory")) return undefined;
  const shown = new Set(readShown(home, session).filter((line) => line.via === "trigger" && line.agent === input.agent_id).map((line) => line.note));
  let repo: string | undefined | null = null;
  const hits: Array<{ note: string; term: string; text: string }> = [];
  for (const trigger of readTriggers(home)) {
    if (hits.length === notesPerCall) break;
    if (shown.has(trigger.note)) continue;
    const term = trigger.terms.find((candidate) => names(candidate, call));
    if (!term) continue;
    const scope = /^projects\/([^/]+)\//.exec(trigger.note)?.[1];
    if (scope && scope !== (repo ??= repoOf(input.cwd ?? process.cwd()))) continue;
    if (!existsSync(join(root, trigger.note))) continue;
    hits.push({ note: trigger.note, term, text: stripFrontmatter(readFileSync(join(root, trigger.note), "utf8")) });
  }
  for (const hit of hits) logShown(home, { session, agent: input.agent_id, via: "trigger", note: hit.note, trigger: hit.term });
  return hits.length ? hits.map((hit) => `Shared memory ${hit.note}, shown because this call names "${hit.term}":\n${clip(hit.text, noteLimit)}`).join("\n\n") : undefined;
}

if (import.meta.main) await answerHook("PreToolUse", (input) => recallNotes(input, process.env.HOME ?? homedir()));
