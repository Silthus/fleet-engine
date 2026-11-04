import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve as resolvePath, sep } from "node:path";
import type {
  AvailableSource,
  DesiredFile,
  FetchedSource,
  LoadedPack,
  MachineFile,
  Need,
  Os,
  PackSetting,
  Plan,
  Profile,
  ResolvedPack,
  SettingValue,
} from "../pack/types.ts";

export class ResolveError extends Error {}

export const engineCommands = ["setup", "apply", "doctor", "update", "packs", "settings", "set", "devbox"];

type Candidate = LoadedPack & { source: AvailableSource };
type Scoped = { on?: Os[]; roles?: MachineFile["role"][]; workflow?: string };

export function resolve(profile: Profile, machine: MachineFile, sources: FetchedSource[]): Plan {
  const os: Os = machine.role === "mac" ? "darwin" : "linux";
  const { order, packs } = choosePacks(profile, sources);
  const plan: Plan = {
    machine,
    os,
    packs,
    workflows: [],
    files: [],
    config: [],
    owners: {},
    jobs: [],
    human: [],
    steps: [],
    checks: [],
    commands: {},
    settings: {},
    unanswered: [],
    dropped: [],
  };
  const names = new Set(order.map((pack) => pack.manifest.name));
  const active = activateWorkflows(profile, machine, order, names, plan);
  const fits = (pack: string, item: Scoped, label: string) => {
    const reason = item.on && !item.on.includes(os) ? `not on ${os}` : item.roles && !item.roles.includes(machine.role) ? `not on a ${machine.role}` : item.workflow && !active.has(item.workflow) ? `workflow ${item.workflow} is off` : undefined;
    if (reason) plan.dropped.push({ pack, item: label, reason });
    return !reason;
  };

  for (const { manifest } of order) {
    const pack = manifest.name;
    for (const job of manifest.jobs ?? []) if (fits(pack, job, `job ${job.id}`)) plan.jobs.push({ ...job, pack });
    for (const step of manifest.human ?? []) if (fits(pack, step, `human ${step.id}`)) plan.human.push({ ...step, pack });
    for (const step of manifest.steps ?? []) if (fits(pack, step, `step ${step.id}`)) plan.steps.push({ ...step, pack });
    for (const check of manifest.checks ?? []) if (fits(pack, check, `check ${check.id}`)) plan.checks.push({ ...check, pack });
    for (const entry of manifest.config ?? []) {
      if (!fits(pack, entry, `config ${entry.provider}:${entry.key}`)) continue;
      const owner = `${entry.provider}:${entry.key}`;
      if (plan.owners[owner]) throw new ResolveError(`${owner} is owned by both ${plan.owners[owner]} and ${pack}`);
      plan.owners[owner] = pack;
      plan.config.push({ ...entry, pack });
    }
  }
  for (const entry of profile.overrides?.config ?? []) {
    const owner = `${entry.provider}:${entry.key}`;
    plan.config = plan.config.filter((item) => `${item.provider}:${item.key}` !== owner);
    plan.owners[owner] = "profile";
    plan.config.push({ ...entry, pack: "profile" });
  }

  const settings = activeSettings(order, active);
  plan.settings = settingValues(settings, profile.settings);
  plan.unanswered = settings.filter((setting) => plan.settings[setting.key] === undefined && !setting.optional && setting.ask !== "never");
  plan.files = [...instructionFiles(order, profile), ...guideFiles(order, settings, plan.settings), ...skillFiles(order, profile, sources, plan)];
  plan.commands = packCommands(order);
  return plan;
}

function choosePacks(profile: Profile, sources: FetchedSource[]) {
  const byName = new Map<string, Candidate>();
  for (const source of sources) {
    if ("error" in source) continue;
    for (const pack of source.packs) {
      const other = byName.get(pack.manifest.name);
      if (other) throw new ResolveError(`pack ${pack.manifest.name} is in both ${other.source.ref.name} and ${source.ref.name}`);
      byName.set(pack.manifest.name, { ...pack, source });
    }
  }
  if (!byName.has("base")) throw new ResolveError("the base pack is missing");
  const unreachable = sources.filter((source) => "error" in source).map((source) => source.ref.name);
  const packs: ResolvedPack[] = [];
  const order: Candidate[] = [];
  const visiting = new Set<string>();
  const visit = (name: string): boolean => {
    if (order.some((pack) => pack.manifest.name === name)) return true;
    if (packs.some((pack) => pack.name === name)) return false;
    if (visiting.has(name)) throw new ResolveError(`packs require each other in a cycle through ${name}`);
    const candidate = byName.get(name);
    if (!candidate) {
      const reason = unreachable.length ? `not found; unreachable sources: ${unreachable.join(", ")}` : "not found in any source";
      packs.push({ name, source: "", ref: "", available: false, reason });
      return false;
    }
    visiting.add(name);
    const missing = (candidate.manifest.requires ?? []).filter((required) => !profile.packs.includes(required) && required !== "base");
    const blocked = (candidate.manifest.requires ?? []).filter((required) => !missing.includes(required) && !visit(required));
    visiting.delete(name);
    const entry = { name, source: candidate.source.ref.name, ref: candidate.source.ref.ref };
    if (missing.length || blocked.length) {
      packs.push({ ...entry, available: false, reason: `requires ${[...missing, ...blocked].join(", ")}` });
      return false;
    }
    packs.push({ ...entry, available: true, ...(candidate.source.stale ? { reason: candidate.source.stale } : {}) });
    order.push(candidate);
    return true;
  };
  for (const name of ["base", ...profile.packs.filter((name) => name !== "base")]) visit(name);
  return { order, packs };
}

function activateWorkflows(profile: Profile, machine: MachineFile, order: Candidate[], names: Set<string>, plan: Plan) {
  const devbox = (profile.devboxes?.length ?? 0) > 0 || machine.role === "devbox" || machine.role === "hub";
  const holds: Record<Need, boolean> = {
    gh: true,
    devbox,
    "always-on devbox": devbox,
    hub: names.has("hub"),
    coder: names.has("posthog"),
    "posthog-org": names.has("posthog"),
  };
  const active = new Set<string>();
  for (const { manifest } of order) {
    for (const workflow of manifest.workflows ?? []) {
      const chosen = profile.workflows[workflow.id] ?? workflow.default;
      const unmet = (workflow.needs ?? []).filter((need) => !holds[need]);
      const reason = !chosen ? "turned off" : unmet.length ? `needs ${unmet.join(", ")}` : undefined;
      plan.workflows.push({ id: workflow.id, pack: manifest.name, active: !reason, ...(reason ? { reason } : {}) });
      if (!reason) active.add(workflow.id);
    }
  }
  return active;
}

function activeSettings(order: Candidate[], active: Set<string>): Array<PackSetting & { pack: string }> {
  return order.flatMap(({ manifest }) => {
    const inactive = new Set((manifest.workflows ?? []).filter((workflow) => !active.has(workflow.id)).flatMap((workflow) => workflow.settings ?? []));
    return (manifest.settings ?? []).filter((setting) => !inactive.has(setting.key)).map((setting) => ({ ...setting, pack: manifest.name }));
  });
}

function settingValues(settings: PackSetting[], answers: Record<string, SettingValue>) {
  const values: Record<string, SettingValue> = {};
  for (const setting of settings) {
    const value = answers[setting.key] ?? setting.default;
    if (value !== undefined) values[setting.key] = value;
  }
  return values;
}

function instructionFiles(order: Candidate[], profile: Profile): DesiredFile[] {
  const fragments = order.flatMap(({ manifest, dir }) => (manifest.instructions ? [read(dir, manifest.instructions, manifest.name)] : []));
  if (profile.aboutMe?.trim()) fragments.push(`## About me\n\n${profile.aboutMe.trim()}\n`);
  const content = fragments.map((fragment) => fragment.trim()).join("\n\n") + "\n";
  return [".agents/AGENTS.md", ".codex/AGENTS.md", ".claude/rules/fleet.md"].map((target) => ({ target, content }));
}

function guideFiles(order: Candidate[], settings: Array<PackSetting & { pack: string }>, values: Record<string, SettingValue>): DesiredFile[] {
  const owners = new Map<string, { pack: string; text: string }>();
  const sections = new Map<string, string[]>();
  for (const { manifest, dir } of order) {
    for (const guide of manifest.guides ?? []) {
      const text = read(dir, guide.path, manifest.name).trim();
      if (guide.section) {
        sections.set(guide.guide, [...(sections.get(guide.guide) ?? []), `## ${guide.section}\n\n${text}`]);
        continue;
      }
      const owner = owners.get(guide.guide);
      if (owner) throw new ResolveError(`guide ${guide.guide} is owned by both ${owner.pack} and ${manifest.name}`);
      owners.set(guide.guide, { pack: manifest.name, text });
    }
  }
  for (const guide of sections.keys()) if (!owners.has(guide)) throw new ResolveError(`guide ${guide} has sections but no owning pack`);
  const files: DesiredFile[] = [...owners].map(([guide, owner]) => ({
    target: `.agents/guides/${guide}.md`,
    content: [owner.text, ...(sections.get(guide) ?? [])].join("\n\n") + "\n",
  }));
  files.push({ target: ".agents/guides/skill-settings.md", content: skillSettings(settings, values) });
  return files;
}

function skillSettings(settings: Array<PackSetting & { pack: string }>, values: Record<string, SettingValue>) {
  const lines = ["# Skill settings", "", "Values that skills read. Fleet writes this file from your profile."];
  let pack = "";
  for (const setting of settings) {
    if (setting.pack !== pack) lines.push("", `## ${(pack = setting.pack)}`, "");
    const value = values[setting.key];
    lines.push(`- \`${setting.key}\`: ${value === undefined ? "not set" : `\`${String(value)}\``}. ${setting.question}`);
  }
  return lines.join("\n") + "\n";
}

function skillFiles(order: Candidate[], profile: Profile, sources: FetchedSource[], plan: Plan): DesiredFile[] {
  const links = new Map<string, { pack: string; dir: string }>();
  const add = (pack: string, packDir: string, path: string) => {
    const dir = skillDir(pack, packDir, path, sources);
    if (!dir) return plan.dropped.push({ pack, item: `skill ${path}`, reason: "its source is unreachable" });
    const name = basename(dir);
    const other = links.get(name);
    if (other) throw new ResolveError(`skill ${name} comes from both ${other.pack} and ${pack}`);
    links.set(name, { pack, dir });
  };
  for (const { manifest, dir } of order) for (const path of manifest.skills ?? []) add(manifest.name, dir, path);
  for (const path of profile.overrides?.skills ?? []) add("profile", profile.dir, path);
  return [...links].flatMap(([name, { dir }]) => [
    { target: `.agents/skills/${name}`, source: dir },
    { target: `.claude/skills/${name}`, source: dir },
  ]);
}

function skillDir(pack: string, packDir: string, path: string, sources: FetchedSource[]) {
  const colon = path.indexOf(":");
  if (colon < 0) return within(packDir, path, pack);
  const name = path.slice(0, colon);
  const source = sources.find((item) => item.ref.name === name);
  if (!source) throw new ResolveError(`${pack}: skill ${path} names unknown source ${name}`);
  return "error" in source ? undefined : within(join(source.dir, "skills"), path.slice(colon + 1), pack);
}

function packCommands(order: Candidate[]) {
  const commands: Plan["commands"] = {};
  for (const { manifest, dir } of order) {
    const root = join(dir, "commands");
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort()) {
      const name = file.slice(0, -3);
      if (engineCommands.includes(name)) throw new ResolveError(`${manifest.name}: command ${name} is reserved by the engine`);
      const other = commands[name];
      if (other) throw new ResolveError(`command ${name} is shipped by both ${other.pack} and ${manifest.name}`);
      commands[name] = { pack: manifest.name, path: join(root, file) };
    }
  }
  return commands;
}

function read(dir: string, path: string, pack: string) {
  return readFileSync(within(dir, path, pack), "utf8");
}

function within(root: string, path: string, pack: string) {
  const full = resolvePath(root, path);
  const rel = relative(resolvePath(root), full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new ResolveError(`${pack}: path ${path} leaves its pack`);
  return full;
}

