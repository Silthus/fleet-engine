import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { answerHook, claimNote, clip, type HookInput, logShown, memoryRoot, repoOf } from "../lib/notes.ts";
import { testsRuleFor } from "../lib/tests-rule.ts";
import { names, readTriggers, stripFrontmatter, textsOf } from "../lib/triggers.ts";

const notesPerCall = 2;
const noteLimit = 3000;

export async function recallNotes(input: HookInput, home: string): Promise<string | undefined> {
  const session = input.session_id;
  if (!session) return undefined;
  const notes = await triggeredNotes(input, home, session).catch(() => undefined);
  const shown = [testsRuleFor(input, home, session), notes].filter(Boolean);
  return shown.length ? shown.join("\n\n") : undefined;
}

async function triggeredNotes(input: HookInput, home: string, session: string): Promise<string | undefined> {
  const root = memoryRoot(home);
  if (!existsSync(root)) return undefined;
  const texts = [input.tool_name ?? "", ...textsOf(input.tool_input)];
  if (texts.some((text) => text.includes(".agents/memory"))) return undefined;
  let repo: string | undefined | null = null;
  const hits: Array<{ note: string; term: string; text: string }> = [];
  for (const trigger of readTriggers(home)) {
    if (hits.length === notesPerCall) break;
    const term = trigger.terms.find((candidate) => texts.some((text) => names(candidate, text)));
    if (!term) continue;
    const scope = /^projects\/([^/]+)\//.exec(trigger.note)?.[1];
    if (scope && scope !== (repo ??= await repoOf(input.cwd ?? process.cwd()))) continue;
    let text: string;
    try {
      text = stripFrontmatter(readFileSync(join(root, trigger.note), "utf8"));
    } catch {
      continue;
    }
    if (claimNote(home, session, input.agent_id, trigger.note)) hits.push({ note: trigger.note, term, text });
  }
  for (const hit of hits) {
    try {
      logShown(home, { session, agent: input.agent_id, via: "trigger", note: hit.note, trigger: hit.term });
    } catch {}
  }
  return hits.length ? hits.map((hit) => `Shared memory ${hit.note}, shown because this call names "${hit.term}":\n${clip(hit.text, noteLimit)}`).join("\n\n") : undefined;
}

if (import.meta.main) await answerHook("PreToolUse", (input) => recallNotes(input, process.env.HOME ?? homedir()));
