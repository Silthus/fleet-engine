import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { needValues, type AvailableSource, type Concept, type PackManifest, type Preset } from "../src/pack/types.ts";
import { tempDirs } from "../src/testing/git.ts";
import { skillSources, devbox, engineSource, resolveEngine } from "../src/testing/packs.ts";

const root = join(import.meta.dir, "..");
const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
let manifests: PackManifest[];
let presets: Preset[];
let concepts: Concept[];
beforeAll(async () => {
  engine = await engineSource();
  manifests = engine.packs.map((pack) => pack.manifest);
  presets = await Bun.file(join(root, "presets.json")).json();
  concepts = await Bun.file(join(root, "concepts.json")).json();
});

const workflows = () => manifests.flatMap((manifest) => (manifest.workflows ?? []).map((workflow) => ({ ...workflow, pack: manifest.name })));
const posthogTerms = /posthog|hogli|stamphog|reviewhog/i;

describe("the catalog", () => {
  test("every pack says what it adds to a day and what it costs", () => {
    for (const manifest of manifests) {
      expect({ pack: manifest.name, day: typeof manifest.day, cost: typeof manifest.cost }).toEqual({ pack: manifest.name, day: "string", cost: "string" });
    }
  });

  test("every workflow has a name, a sentence, needs from the closed set, a default, and a moment", () => {
    for (const workflow of workflows()) {
      const label = `${workflow.pack}/${workflow.id}`;
      expect([label, typeof workflow.name, /^[A-Z].*\.$/.test(workflow.sentence), typeof workflow.default]).toEqual([label, "string", true, "boolean"]);
      for (const need of workflow.needs ?? []) expect([label, needValues]).toEqual([label, expect.arrayContaining([need])]);
      expect([label, workflow.moment?.time]).toEqual([label, expect.stringMatching(/^([01]\d|2[0-3]):[0-5]\d$/)]);
      expect([label, Boolean(workflow.moment?.title && workflow.moment.body)]).toEqual([label, true]);
    }
  });

  test("every word a moment uses has one public concept note", () => {
    const words = concepts.map((concept) => concept.word);
    expect(new Set(words).size).toBe(words.length);
    const publicWords = concepts.filter((concept) => concept.audience !== "posthog").map((concept) => concept.word);
    const used = workflows().flatMap((workflow) => workflow.moment?.words ?? []);
    expect(used.filter((word) => !publicWords.includes(word))).toEqual([]);
  });

  test("marks every PostHog concept for the PostHog audience", () => {
    for (const concept of concepts) {
      expect([concept.word, concept.audience ?? "public"]).toEqual([concept.word, expect.stringMatching(/^(public|posthog)$/)]);
      if (posthogTerms.test(`${concept.word} ${concept.note}`)) expect([concept.word, concept.audience]).toEqual([concept.word, "posthog"]);
    }
  });

  test("offers Starter, Everyday, and Michael's, each resolving with every pack it names", () => {
    expect(presets.map((preset) => preset.id)).toEqual(["starter", "everyday", "michael"]);
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
});
