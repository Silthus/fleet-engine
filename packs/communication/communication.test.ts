import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { agentSkillsSource, engineSource, fileContent, resolveEngine } from "../../src/testing/packs.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const withPack = (fields = {}) => resolveEngine([engine, agentSkillsSource(temp.make("agent-skills-"), engine)], { packs: ["communication"], ...fields });
const skillSource = (result: ReturnType<typeof withPack>, name: string) => result.files.find((file) => file.target === `.claude/skills/${name}` && "source" in file);

describe("the Communication pack", () => {
  test("adds its rules and links the neutral voice and the sharing skills", () => {
    const result = withPack();
    const agents = fileContent(result, ".agents/AGENTS.md");
    expect(agents.slice(agents.indexOf("# Communication"))).toMatchSnapshot();
    expect(skillSource(result, "writing-voice")).toEqual({ target: ".claude/skills/writing-voice", source: join(import.meta.dir, "skills/writing-voice") });
    for (const name of ["share-plan", "explain-diff", "share-preview"]) expect(skillSource(result, name)).toBeDefined();
  });

  test("lets the profile's own voice replace the neutral one", () => {
    const dir = temp.make("profile-");
    mkdirSync(join(dir, "skills/writing-voice"), { recursive: true });
    writeFileSync(join(dir, "skills/writing-voice/SKILL.md"), "# My voice\n");
    const result = withPack({ dir, overrides: { skills: ["skills/writing-voice"] } });
    expect(skillSource(result, "writing-voice")).toEqual({ target: ".claude/skills/writing-voice", source: join(dir, "skills/writing-voice") });
  });

  test("offers previews only with Coder", () => {
    expect(withPack().workflows.find((workflow) => workflow.id === "previews")).toMatchObject({ active: false, reason: "needs coder" });
    expect(withPack().workflows.filter((workflow) => workflow.pack === "communication" && workflow.active).map((workflow) => workflow.id)).toEqual(["voice", "updates"]);
  });
});
