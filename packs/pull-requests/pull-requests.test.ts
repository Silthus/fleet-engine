import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { agentSkillsSource, engineSource, fileContent, resolveEngine } from "../../src/testing/packs.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const withPack = (fields = {}) => resolveEngine([engine, agentSkillsSource(temp.make("agent-skills-"), engine)], { packs: ["pull-requests"], ...fields });

describe("the Pull-requests pack", () => {
  test("adds its rules after Base and points at its guides", () => {
    const agents = fileContent(withPack(), ".agents/AGENTS.md");
    expect(agents.indexOf("# Pull requests")).toBeGreaterThan(agents.indexOf("## Model selection"));
    expect(agents.slice(agents.indexOf("# Pull requests"))).toMatchSnapshot();
  });

  test("writes both guides and its settings with their defaults", () => {
    const result = withPack();
    expect(result.files.map((file) => file.target)).toEqual(expect.arrayContaining([".agents/guides/pull-requests.md", ".agents/guides/standing-rules.md"]));
    expect(result.unanswered).toEqual([]);
    expect(fileContent(result, ".agents/guides/skill-settings.md")).toContain("- `pull-requests.mergeCommand`: `gh pr merge --merge`. Which command merges a pull request when the repo names none?");
    expect(result.settings).toMatchObject({ "pull-requests.freeReviews": 2, "pull-requests.reviewCeiling": 6, "pull-requests.reviewTimeoutMinutes": 20, "pull-requests.panelSlots": 3 });
  });

  test("links each pull-request skill from agent-skills for Claude and for other agents", () => {
    const links = withPack().files.filter((file) => "source" in file && file.target.startsWith(".claude/skills/")).map((file) => file.target.split("/").pop());
    expect(links).toEqual(expect.arrayContaining(["full-stop", "full-send", "stamp-pr", "babysit-pr", "pr-description", "qa-swarm", "merge-risk", "rollout"]));
    expect(withPack().files.filter((file) => file.target.startsWith(".agents/skills/"))).toHaveLength(links.length);
  });

  test("drops a workflow's setting when the workflow is off", () => {
    const result = withPack({ workflows: { "ship-words": false } });
    expect(result.settings["pull-requests.mergeCommand"]).toBeUndefined();
    expect(result.workflows.find((workflow) => workflow.id === "ship-words")).toMatchObject({ active: false, reason: "turned off" });
  });

  test("says which source it needs when the profile does not list agent-skills", () => {
    expect(() => resolveEngine([engine], { packs: ["pull-requests"] })).toThrow("pull-requests: skill agent-skills:pull-requests/full-stop names unknown source agent-skills");
  });
});
