import { join, resolve } from "node:path";
import { engineSettings, loadPacks } from "../src/pack/manifest.ts";
import type { Audience, Concept, LoadedPack, Need, PackManifest, Preset } from "../src/pack/types.ts";
import { engineRepo } from "../src/setup/defaults.ts";
import { choosablePacks, defaultPreset, filledBySetup, title, type Catalog } from "../src/setup/questions.ts";
import type { PageData, PagePack } from "../page/model.ts";

const engineRoot = join(import.meta.dir, "..");

/** Needs that hold only while a pack is on, the way resolve decides them. A workflow whose pack is not in the build is left out. */
export const needPacks: Partial<Record<Need, string>> = { hub: "hub", coder: "posthog", "posthog-org": "posthog" };

const needLabels: Record<Need, string> = {
  gh: "GitHub",
  devbox: "a devbox",
  "always-on devbox": "an always-on devbox",
  hub: "the Hub pack",
  coder: "Coder",
  "posthog-org": "your team's GitHub org",
};

export type PageOptions = { audience: Audience; team?: LoadedPack[] };

const visible = (audience: Audience) => (item: { audience?: Audience }) => !item.audience || item.audience === "public" || item.audience === audience;

export async function pageData({ audience, team = [] }: PageOptions): Promise<PageData> {
  if (audience === "public" && team.length) throw new Error("the public build lists no pack from a private source");
  const engine = await loadPacks(engineRoot);
  const presets = (await Bun.file(join(engineRoot, "presets.json")).json()) as Preset[];
  const concepts = (await Bun.file(join(engineRoot, "concepts.json")).json()) as Concept[];
  const shown = visible(audience);
  const base = engine.filter((pack) => pack.manifest.name === "base").map((pack) => pack.manifest);
  const teamManifests = team.map((pack) => pack.manifest).filter(shown);
  const manifests = [...base, ...choosablePacks({ presets, packs: engine } as Catalog), ...teamManifests].filter(shown);
  const names = new Set(manifests.map((manifest) => manifest.name));
  const holds = (need: Need) => !needPacks[need] || names.has(needPacks[need]!);
  const packs = manifests.map((manifest) => pagePack(manifest, holds));
  const workflowIds = new Set(packs.flatMap((pack) => pack.workflows.map((workflow) => workflow.id)));
  const used = new Set(packs.flatMap((pack) => pack.workflows.flatMap((workflow) => workflow.needs)));
  const words = new Set(packs.flatMap((pack) => pack.workflows.flatMap((workflow) => workflow.moment?.words ?? [])));
  const teamPacks = teamManifests.map((manifest) => manifest.name);
  return {
    engineRepo,
    defaultPreset,
    filledBySetup: [...filledBySetup],
    presets: presets.map((preset) => ({
      ...preset,
      packs: preset.packs.filter((name) => names.has(name)),
      workflows: Object.fromEntries(Object.entries(preset.workflows).filter(([id]) => workflowIds.has(id))),
    })),
    packs,
    teamPacks,
    concepts: concepts.filter(shown).filter((concept) => words.has(concept.word)).map(({ word, note }) => ({ word, note })),
    needPacks: Object.fromEntries(Object.entries(needPacks).filter(([need]) => used.has(need as Need))),
    needLabels: Object.fromEntries(Object.entries(needLabels).filter(([need]) => used.has(need as Need))),
    teamNote: teamPacks.length
      ? `The ${teamPacks.map(title).join(" and ")} pack comes from your team's private pack source. Setup ticks it when GitHub shows you are in the team's org.`
      : "A team can add its own pack from a private pack source: a GitHub repo of packs. Setup ticks it for members of the team's GitHub org.",
  };
}

function pagePack(manifest: PackManifest, holds: (need: Need) => boolean): PagePack {
  const workflows = manifest.workflows ?? [];
  const shownWorkflows = workflows.filter((workflow) => (workflow.needs ?? []).every(holds));
  const listedOnlyByHidden = (key: string) => workflows.some((workflow) => workflow.settings?.includes(key)) && !shownWorkflows.some((workflow) => workflow.settings?.includes(key));
  return {
    name: manifest.name,
    title: title(manifest.name),
    summary: manifest.summary,
    ...(manifest.day ? { day: manifest.day } : {}),
    ...(manifest.cost ? { cost: manifest.cost } : {}),
    ...(manifest.risk ? { risk: manifest.risk } : {}),
    requires: (manifest.requires ?? []).filter((name) => name !== "base"),
    always: manifest.name === "base",
    workflows: shownWorkflows.map((workflow) => ({ ...workflow, needs: workflow.needs ?? [], settings: workflow.settings ?? [] })),
    settings: (manifest.settings ?? []).filter((setting) => !engineSettings.includes(setting.key) && !listedOnlyByHidden(setting.key)),
  };
}

export async function buildPage(options: PageOptions) {
  const data = await pageData(options);
  const bundle = await Bun.build({ entrypoints: [join(engineRoot, "page/app.ts")], root: engineRoot, target: "browser" });
  if (!bundle.success) throw new AggregateError(bundle.logs, "the page script did not build");
  const script = await bundle.outputs[0]!.text();
  const style = await Bun.file(join(engineRoot, "page/style.css")).text();
  const shell = await Bun.file(join(engineRoot, "page/shell.html")).text();
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return shell
    .replace("/*style*/", () => style.trim())
    .replace("{}/*data*/", () => json)
    .replace("/*script*/", () => script.trim().replaceAll("</script", "<\\/script"));
}

export async function main(args: string[]) {
  let audience: Audience = "public";
  let out = "page/index.html";
  const team: LoadedPack[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = () => args[++index] ?? fail(`${arg} needs a value`);
    if (arg === "--audience") {
      const name = value();
      if (name !== "public" && name !== "posthog") fail("--audience takes public or posthog");
      audience = name as Audience;
    } else if (arg === "--source") team.push(...(await loadPacks(resolve(value()))));
    else if (arg === "--out") out = value();
    else fail(`unknown option ${arg}. Use --audience, --source <dir>, and --out <file>`);
  }
  await Bun.write(out, await buildPage({ audience, team }));
  console.log(`Wrote ${out}`);
}

function fail(message: string): never {
  console.error(`build-page: ${message}`);
  process.exit(2);
}

if (import.meta.main) await main(Bun.argv.slice(2));
