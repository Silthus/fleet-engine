import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, skillSources, engineSource, fileContent, mac, resolveEngine } from "../../src/testing/packs.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const loops = ["quality-loop", "signal-loop", "pr-digest"];
const withPack = (fields = {}, machine = mac) =>
  resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["pull-requests", "orchestration"], ...fields }, machine);

describe("the Orchestration pack", () => {
  test("adds its rules after the Pull-requests pack", () => {
    const result = withPack();
    const agents = fileContent(result, ".agents/AGENTS.md");
    expect(agents.indexOf("# Orchestration")).toBeGreaterThan(agents.indexOf("# Pull requests"));
    expect(agents.slice(agents.indexOf("# Orchestration"))).toMatchSnapshot();
  });

  test("needs the Pull-requests pack", () => {
    const result = resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["orchestration"] });
    expect(result.packs.find((pack) => pack.name === "orchestration")).toMatchObject({ available: false, reason: "requires pull-requests" });
  });

  test("links the wayfinder skills, and the wayfinder foundation from the pinned third-party source", () => {
    const links = withPack().files.filter((file) => "source" in file && file.target.startsWith(".claude/skills/")).map((file) => file.target.split("/").pop());
    expect(links).toEqual(expect.arrayContaining(["orchestration-wayfinder", "architecture", "impact", "lessons", "quality-loop", "signal-loop", "t3-kickoff", "usage-brief"]));
    expect(links).toEqual(expect.arrayContaining(["wayfinder", "grilling", "research", "prototype", "domain-modeling", "setup-matt-pocock-skills", "codebase-design"]));
  });

  test("keeps maps and side threads on, the loops off, and asks nothing by default", () => {
    const result = withPack({}, devbox);
    const orchestration = result.workflows.filter((workflow) => workflow.pack === "orchestration");
    expect(orchestration.filter((workflow) => workflow.active).map((workflow) => workflow.id)).toEqual(["maps", "side-threads"]);
    expect(orchestration.filter((workflow) => loops.includes(workflow.id)).map((workflow) => workflow.reason)).toEqual(["turned off", "turned off", "turned off"]);
    expect(result.jobs.filter((job) => job.pack === "orchestration")).toEqual([]);
    expect(result.unanswered).toEqual([]);
  });

  test("runs a turned-on loop only on an always-on devbox", () => {
    const onMac = withPack({ workflows: { "quality-loop": true } });
    expect(onMac.workflows.find((workflow) => workflow.id === "quality-loop")).toMatchObject({ active: false, reason: "needs always-on devbox" });
    expect(onMac.unanswered).toEqual([]);
    const settings = { "orchestration.loopProject": "my-repo", "orchestration.qualityArea": "src", "orchestration.ledgerRepo": "me/ledger" };
    const macWithDevbox = withPack({ devboxes: ["box"], workflows: { "quality-loop": true }, settings });
    expect(macWithDevbox.workflows.find((workflow) => workflow.id === "quality-loop")).toMatchObject({ active: true });
    expect(macWithDevbox.jobs.map((job) => job.id)).not.toContain("quality-loop");
    expect(withPack({ workflows: { "quality-loop": true }, settings }, devbox).jobs.map((job) => job.id)).toContain("quality-loop");
  });

  test("asks for the loop settings once, and passes the project to every turned-on loop's T3 task", () => {
    const workflows = { "quality-loop": true, "pr-digest": true };
    expect(withPack({ workflows }, devbox).unanswered.map((setting) => setting.key)).toEqual(["orchestration.loopProject", "orchestration.qualityArea", "orchestration.ledgerRepo"]);
    const result = withPack({ workflows, settings: { "orchestration.loopProject": "my-repo", "orchestration.qualityArea": "src", "orchestration.ledgerRepo": "me/ledger" } }, devbox);
    const jobs = result.jobs.filter((job) => job.pack === "orchestration");
    expect(jobs.map((job) => [job.id, job.runner, job.task?.project, job.task?.modelRole])).toEqual([
      ["quality-loop", "t3", "my-repo", "implementation"],
      ["pr-digest", "t3", "my-repo", "lookup"],
    ]);
    expect(result.models.map((row) => row.role)).toEqual(expect.arrayContaining(jobs.map((job) => job.task!.modelRole)));
  });

  test("asks for the scope and ledger when only the signal loop is on, and falls back to an analytics MCP", () => {
    expect(withPack({ workflows: { "signal-loop": true } }, devbox).unanswered.map((setting) => setting.key)).toEqual(["orchestration.loopProject", "orchestration.qualityArea", "orchestration.ledgerRepo"]);
    const result = withPack({ workflows: { "signal-loop": true }, settings: { "orchestration.loopProject": "my-repo", "orchestration.qualityArea": "src", "orchestration.ledgerRepo": "me/ledger" } }, devbox);
    expect(result.jobs.find((job) => job.id === "signal-loop")?.task?.prompt).toContain("from an analytics MCP, such as PostHog's, when one is connected");
  });

  test("keeps every loop lane a draft and never lets an unattended loop wait on a question", () => {
    const manifest = engine.packs.find((pack) => pack.manifest.name === "orchestration")!.manifest;
    for (const id of ["quality-loop", "signal-loop"]) {
      const prompt = manifest.jobs!.find((job) => job.id === id)!.task!.prompt;
      expect(prompt).toContain("Every lane stops at a draft pull request: no lane runs stamp-pr or full-send, merges, or deploys");
      expect(prompt).toContain("Never ask a question");
      expect(prompt).toContain("NEEDS_HUMAN:");
    }
  });
});
