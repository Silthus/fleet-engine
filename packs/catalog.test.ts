import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { needValues, type AvailableSource, type PackManifest, type Preset } from "../src/pack/types.ts";
import { needsHubPacks } from "../src/setup/defaults.ts";
import { tempDirs } from "../src/testing/git.ts";
import { skillSources, devbox, engineSource, resolveEngine } from "../src/testing/packs.ts";

const root = join(import.meta.dir, "..");
const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
let manifests: PackManifest[];
let presets: Preset[];
beforeAll(async () => {
  engine = await engineSource();
  manifests = engine.packs.map((pack) => pack.manifest);
  presets = await Bun.file(join(root, "presets.json")).json();
});

const workflows = () => manifests.flatMap((manifest) => (manifest.workflows ?? []).map((workflow) => ({ ...workflow, pack: manifest.name })));
const workflowFields = ["id", "name", "sentence", "needs", "requires", "default", "settings", "risk"];

describe("the catalog", () => {
  test("every pack says what it adds to a day and what it costs", () => {
    for (const manifest of manifests) {
      expect({ pack: manifest.name, day: typeof manifest.day, cost: typeof manifest.cost }).toEqual({ pack: manifest.name, day: "string", cost: "string" });
    }
  });

  test("every workflow has a name, a sentence, needs from the closed set, a default, and only the fields the engine reads", () => {
    for (const workflow of workflows()) {
      const label = `${workflow.pack}/${workflow.id}`;
      expect([label, typeof workflow.name, /^[A-Z].*\.$/.test(workflow.sentence), typeof workflow.default]).toEqual([label, "string", true, "boolean"]);
      for (const need of workflow.needs ?? []) expect([label, needValues]).toEqual([label, expect.arrayContaining([need])]);
      expect([label, Object.keys(workflow).filter((key) => key !== "pack" && !workflowFields.includes(key))]).toEqual([label, []]);
    }
  });

  test("offers Starter, Everyday, and Everything, each resolving with every pack it names", () => {
    expect(presets.map((preset) => preset.id)).toEqual(["starter", "everyday", "everything"]);
    const names = manifests.map((manifest) => manifest.name);
    for (const preset of presets) {
      expect([preset.id, preset.packs.filter((pack) => !names.includes(pack))]).toEqual([preset.id, []]);
      const offered = workflows().filter((workflow) => workflow.pack === "base" || preset.packs.includes(workflow.pack)).map((workflow) => workflow.id);
      expect([preset.id, Object.keys(preset.workflows).filter((id) => !offered.includes(id))]).toEqual([preset.id, []]);
      const plan = resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: preset.packs, workflows: preset.workflows }, devbox);
      expect([preset.id, plan.packs.filter((pack) => !pack.available)]).toEqual([preset.id, []]);
      const on = new Set(plan.workflows.filter((workflow) => workflow.active).map((workflow) => workflow.id));
      expect([preset.id, Object.keys(preset.workflows).filter((id) => preset.workflows[id] && !on.has(id))]).toEqual([preset.id, []]);
    }
  });

  test("Everything names every pack, on the first machine or once a hub runs, and each preset's hub packs and hub workflows exist", () => {
    const everything = presets.find((preset) => preset.id === "everything")!;
    const optional = manifests.map((manifest) => manifest.name).filter((name) => name !== "base");
    expect([...everything.packs, ...(everything.hubPacks ?? [])].toSorted()).toEqual(optional.toSorted());
    for (const preset of presets) {
      const later = [...preset.packs, ...(preset.hubPacks ?? [])];
      expect([preset.id, (preset.hubPacks ?? []).filter((name) => !needsHubPacks.includes(name))]).toEqual([preset.id, []]);
      expect([preset.id, preset.packs.filter((name) => needsHubPacks.includes(name))]).toEqual([preset.id, []]);
      const offered = workflows().filter((workflow) => later.includes(workflow.pack)).map((workflow) => workflow.id);
      expect([preset.id, Object.keys(preset.hubWorkflows ?? {}).filter((id) => !offered.includes(id))]).toEqual([preset.id, []]);
    }
  });

  test("turns on each preset's default workflows, and names the need that holds one back", () => {
    const everyday = presets.find((preset) => preset.id === "everyday")!;
    const plan = resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: everyday.packs, workflows: everyday.workflows }, devbox);
    const state = (id: string) => plan.workflows.find((workflow) => workflow.id === id);
    expect(["maps", "side-threads", "voice", "updates"].map((id) => state(id)?.active)).toEqual([true, true, true, true]);
    expect(state("previews")).toMatchObject({ active: false, reason: "needs coder" });
  });
});
