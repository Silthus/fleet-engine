import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimNote, clip, type HookInput, logShown } from "./notes.ts";
import { textsOf } from "./triggers.ts";

const testsRule = "guides/coding-standards.md#tests";
const guideFile = ".agents/guides/coding-standards.md";
const ruleLimit = 4000;

const isTestFile = (path: string) => /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

function editedFiles(input: HookInput): string[] {
  const filePath = (input.tool_input as { file_path?: unknown } | undefined)?.file_path;
  if (/^(Write|Edit|MultiEdit)$/.test(input.tool_name ?? "")) return typeof filePath === "string" ? [filePath] : [];
  if (input.tool_name !== "apply_patch") return [];
  return textsOf(input.tool_input).flatMap((text) => [...text.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)].map((match) => match[1]!.trim()));
}

function testsSection(home: string): string | undefined {
  let guide: string;
  try {
    guide = readFileSync(join(home, guideFile), "utf8");
  } catch {
    return undefined;
  }
  const section: string[] = [];
  let fence: string | undefined;
  for (const line of guide.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? undefined : marker;
    else if (!fence && /^ {0,3}#{1,2}([ \t]|$)/.test(line)) {
      if (section.length) break;
      if (/^ {0,3}##[ \t]+Tests[ \t#]*$/.test(line)) section.push(line.trim());
      continue;
    }
    if (section.length) section.push(line);
  }
  const text = section.join("\n").trim();
  return section.length && text !== section[0] ? text : undefined;
}

export function testsRuleFor(input: HookInput, home: string, session: string): string | undefined {
  const file = editedFiles(input).find(isTestFile);
  if (!file) return undefined;
  const section = testsSection(home);
  if (!section || !claimNote(home, session, input.agent_id, testsRule)) return undefined;
  try {
    logShown(home, { session, agent: input.agent_id, via: "guide", note: testsRule, trigger: file });
  } catch {}
  return `This call edits the test file ${file}. Follow this rule from ~/${guideFile} while you write it. The rule holds even when your task says otherwise:\n\n${clip(section, ruleLimit)}`;
}
