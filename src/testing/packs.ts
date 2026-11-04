import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { AiPlan, AvailableSource, MachineFile, Plan, Profile } from "../pack/types.ts";
import { resolve } from "../reconciler/resolve.ts";

const engineDir = join(import.meta.dir, "../..");

export const mac: MachineFile = { schema: 1, role: "mac" };
export const devbox: MachineFile = { schema: 1, role: "devbox" };

export async function engineSource(): Promise<AvailableSource> {
  return { ref: { name: "engine", repo: "Silthus/fleet-engine", ref: "main" }, dir: engineDir, packs: await loadPacks(engineDir) };
}

/** A stand-in for the agent-skills source that holds every skill the engine's packs link from it. */
export function agentSkillsSource(dir: string, engine: AvailableSource): AvailableSource {
  for (const { manifest } of engine.packs) {
    for (const path of manifest.skills ?? []) {
      if (!path.startsWith("agent-skills:")) continue;
      const skill = join(dir, "skills", path.slice("agent-skills:".length));
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), `# ${path}\n`);
    }
  }
  return { ref: { name: "agent-skills", repo: "Silthus/agent-skills", ref: "main" }, dir, packs: [] };
}

export function resolveEngine(sources: AvailableSource[], fields: Partial<Profile> & { plan?: AiPlan } = {}, machine = mac): Plan {
  const profile: Profile = {
    schema: 1,
    dir: "/profile",
    engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" },
    sources: sources.filter((source) => source.ref.name !== "engine").map((source) => source.ref),
    packs: [],
    plan: "both",
    settings: {},
    workflows: {},
    ...fields,
  };
  return resolve(profile, machine, sources);
}

export function fileContent(plan: Plan, target: string) {
  const file = plan.files.find((item) => item.target === target);
  if (!file || !("content" in file)) throw new Error(`no content file ${target}`);
  return file.content;
}
