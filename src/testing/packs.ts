import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { AiPlan, AvailableSource, MachineFile, Plan, Profile } from "../pack/types.ts";
import type { Runner } from "../reconciler/apply.ts";
import { resolve } from "../reconciler/resolve.ts";

const engineDir = join(import.meta.dir, "../..");

export const mac: MachineFile = { schema: 1, role: "mac" };
export const devbox: MachineFile = { schema: 1, role: "devbox" };

export async function engineSource(): Promise<AvailableSource> {
  return { ref: { name: "engine", repo: "Silthus/fleet-engine", ref: "main" }, dir: engineDir, packs: await loadPacks(engineDir) };
}

const skillRepos: Record<string, string> = { "agent-skills": "Silthus/agent-skills", "mattpocock-skills": "mattpocock/skills" };

/** Stand-ins for the skill sources the engine's packs link from, such as agent-skills, each holding every skill the packs name. */
export function skillSources(dir: string, engine: AvailableSource): AvailableSource[] {
  const names = new Set<string>();
  for (const { manifest } of engine.packs) {
    for (const path of manifest.skills ?? []) {
      const colon = path.indexOf(":");
      if (colon < 0) continue;
      const name = path.slice(0, colon);
      const skill = join(dir, name, "skills", path.slice(colon + 1));
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), `# ${path}\n`);
      names.add(name);
    }
  }
  return [...names].map((name) => ({ ref: { name, repo: skillRepos[name] ?? name, ref: "main" }, dir: join(dir, name), packs: [] }));
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

export function engineSteps(engineRoot: string, fleet: (args: string[]) => Promise<number>, other: Runner = async () => 0): Runner {
  const launcher = join(engineRoot, "fleet");
  return async (command) => {
    if (command[0] !== "/bin/sh" || command[1] !== launcher) return other(command);
    return existsSync(join(engineRoot, "packs/base/commands", `${command[2]}.ts`)) ? 0 : fleet(command.slice(2));
  };
}

export function fileContent(plan: Plan, target: string) {
  const file = plan.files.find((item) => item.target === target);
  if (!file || !("content" in file)) throw new Error(`no content file ${target}`);
  return file.content;
}
