import type { Need, PackSetting, SettingValue } from "../src/pack/types.ts";

export type PageWorkflow = {
  id: string;
  name: string;
  sentence: string;
  needs: Need[];
  requires: string[];
  default: boolean;
  settings: string[];
  risk?: string;
};

export type PagePack = {
  name: string;
  title: string;
  summary: string;
  day?: string;
  cost?: string;
  risk?: string;
  requires: string[];
  always: boolean;
  workflows: PageWorkflow[];
  settings: PackSetting[];
};

export type PagePreset = { id: string; name: string; blurb: string; packs: string[]; hubPacks: string[]; hubWorkflows: Record<string, boolean>; workflows: Record<string, boolean> };

export type Where = "mac" | "hub";

export type PageData = {
  engineRepo: string;
  defaultPreset: string;
  filledBySetup: string[];
  presets: PagePreset[];
  packs: PagePack[];
  /** Packs from a team's private source, which setup ticks in every preset. */
  teamPacks: string[];
  ownDevboxPacks: string[];
  needsHubPacks: string[];
  prefersHubPacks: string[];
  /** Needs that hold only while a pack is on, such as hub. */
  needPacks: Partial<Record<Need, string>>;
  needLabels: Partial<Record<Need, string>>;
  teamNote: string;
  overview: { image: string; alt: string };
};

export type Picks = { preset: string; where: Where; packs: string[]; workflows: Record<string, boolean>; settings: Record<string, SettingValue>; hubPathWorkflows?: string[] };

type WorkflowState = { on: true } | { on: false; fix: { pack: string } | { workflow: string } };

type RunState = WorkflowState | { on: false; fix: { where: "hub" } };

const packOf = (data: PageData, name: string) => data.packs.find((pack) => pack.name === name);
export const workflowOf = (data: PageData, id: string) => data.packs.flatMap((pack) => pack.workflows).find((workflow) => workflow.id === id);
const presetOf = (data: PageData, id: string) => data.presets.find((preset) => preset.id === id) ?? data.presets.find((preset) => preset.id === data.defaultPreset)!;
const presetPacks = (data: PageData, preset: PagePreset, where: Where) => [...new Set([...preset.packs, ...data.teamPacks, ...(where === "hub" ? preset.hubPacks : [])])];
const inPageOrder = (data: PageData, names: Iterable<string>) => {
  const wanted = new Set(names);
  return data.packs.map((pack) => pack.name).filter((name) => wanted.has(name));
};
const picked = (data: PageData, picks: Picks) => data.packs.filter((pack) => pack.always || picks.packs.includes(pack.name));
const sameSet = (left: string[], right: string[]) => left.length === right.length && left.every((item) => right.includes(item));

export const chosen = (picks: Pick<Picks, "workflows">, workflow: PageWorkflow) => picks.workflows[workflow.id] ?? workflow.default;

export function presetPicks(data: PageData, id: string, settings: Picks["settings"] = {}, where: Where = "mac"): Picks {
  const preset = presetOf(data, id);
  const hubWorkflows = where === "hub" ? preset.hubWorkflows : {};
  return { preset: preset.id, where, packs: presetPacks(data, preset, where), workflows: { ...preset.workflows, ...hubWorkflows }, settings, hubPathWorkflows: Object.keys(hubWorkflows) };
}

export function setWhere(data: PageData, picks: Picks, where: Where): Picks {
  if (picks.where === where) return picks;
  const preset = presetOf(data, picks.preset);
  const packs = where === "hub" ? [...picks.packs, ...preset.hubPacks] : picks.packs.filter((name) => !data.needsHubPacks.includes(name));
  const fromPath = picks.hubPathWorkflows ?? [];
  const added = Object.keys(preset.hubWorkflows).filter((id) => !Object.hasOwn(picks.workflows, id));
  const workflows = where === "hub" ? { ...preset.hubWorkflows, ...picks.workflows } : Object.fromEntries(Object.entries(picks.workflows).filter(([id]) => !fromPath.includes(id)));
  return { ...picks, where, packs: inPageOrder(data, packs), workflows, hubPathWorkflows: where === "hub" ? added : [] };
}

export function setupSplit(data: PageData, picks: Picks) {
  const hubSide = [...data.needsHubPacks, ...data.prefersHubPacks];
  const waits = (name: string) => picks.where === "hub" && hubSide.includes(name);
  return { first: inPageOrder(data, picks.packs.filter((name) => !waits(name))), later: hubSide.filter((name) => waits(name) && picks.packs.includes(name)) };
}

const firstSetup = (data: PageData, picks: Picks): Picks => ({ ...picks, packs: setupSplit(data, picks).first });

export function togglePack(data: PageData, picks: Picks, name: string): Picks {
  if (packOf(data, name)?.always) return picks;
  if (picks.where === "mac" && data.needsHubPacks.includes(name)) return picks;
  const packs = new Set(picks.packs);
  if (packs.has(name)) {
    const drop = (target: string) => {
      packs.delete(target);
      for (const pack of data.packs) if (packs.has(pack.name) && pack.requires.includes(target)) drop(pack.name);
    };
    drop(name);
  } else {
    const add = (target: string) => {
      const pack = packOf(data, target);
      if (!pack || pack.always || packs.has(target)) return;
      packs.add(target);
      pack.requires.forEach(add);
    };
    add(name);
  }
  return { ...picks, packs: inPageOrder(data, packs) };
}

export function toggleWorkflow(data: PageData, picks: Picks, id: string): Picks {
  const workflow = workflowOf(data, id);
  if (!workflow) return picks;
  const workflows = { ...picks.workflows };
  const turn = (target: PageWorkflow, on: boolean) => {
    if (chosen({ workflows }, target) === on) return;
    workflows[target.id] = on;
    if (on) target.requires.map((required) => workflowOf(data, required)).forEach((required) => required && turn(required, true));
    else data.packs.flatMap((pack) => pack.workflows).filter((item) => item.requires.includes(target.id)).forEach((item) => turn(item, false));
  };
  turn(workflow, !chosen(picks, workflow));
  const untouched = (picks.hubPathWorkflows ?? []).filter((item) => workflows[item] === picks.workflows[item]);
  return { ...picks, workflows, hubPathWorkflows: untouched };
}

export function setSetting(_data: PageData, picks: Picks, key: string, value: SettingValue | undefined): Picks {
  const settings = { ...picks.settings };
  if (value === undefined || value === "") delete settings[key];
  else settings[key] = value;
  return { ...picks, settings };
}

/** The pack a workflow still needs, beyond its own pack, such as hub. */
export function missingPack(data: PageData, picks: Picks, workflow: PageWorkflow) {
  return workflow.needs.map((need) => data.needPacks[need]).find((name): name is string => !!name && !picks.packs.includes(name));
}

export function workflowState(data: PageData, picks: Picks, workflow: PageWorkflow, pack = data.packs.find((item) => item.workflows.includes(workflow))?.name, seen = new Set<string>()): WorkflowState {
  const owner = pack ? packOf(data, pack) : undefined;
  if (owner && !owner.always && !picks.packs.includes(owner.name)) return { on: false, fix: { pack: owner.name } };
  if (!chosen(picks, workflow)) return { on: false, fix: { workflow: workflow.id } };
  const missing = missingPack(data, picks, workflow);
  if (missing) return { on: false, fix: { pack: missing } };
  seen.add(workflow.id);
  for (const id of workflow.requires.filter((required) => !seen.has(required))) {
    const required = workflowOf(data, id);
    const state = required ? workflowState(data, picks, required, undefined, seen) : ({ on: false, fix: { workflow: id } } as const);
    if (!state.on) return state;
  }
  return { on: true };
}

const remoteNeeds: Need[] = ["devbox", "always-on devbox", "hub"];

export const waitsForHub = (picks: Picks, workflow: PageWorkflow) => picks.where === "mac" && workflow.needs.some((need) => remoteNeeds.includes(need));

export function runState(data: PageData, picks: Picks, workflow: PageWorkflow): RunState {
  const state = workflowState(data, picks, workflow);
  const hubPack = !state.on && "pack" in state.fix && data.needsHubPacks.includes(state.fix.pack);
  if (picks.where === "mac" && (hubPack || (state.on && waitsForHub(picks, workflow)))) return { on: false, fix: { where: "hub" } };
  return state;
}

const presetChoice = (preset: PagePreset, workflow: PageWorkflow, where: Where = "mac") => (where === "hub" ? preset.hubWorkflows[workflow.id] : undefined) ?? preset.workflows[workflow.id] ?? workflow.default;

export function activePreset(data: PageData, picks: Picks) {
  const matches = (preset: PagePreset) =>
    sameSet(presetPacks(data, preset, picks.where), picks.packs) &&
    picked(data, picks).every((pack) => pack.workflows.every((workflow) => chosen(picks, workflow) === presetChoice(preset, workflow, picks.where)));
  const own = presetOf(data, picks.preset);
  return matches(own) ? own : data.presets.find(matches);
}

const devboxNeeds: Need[] = ["devbox", "always-on devbox"];

/** Setup on the Mac plans before it asks about a devbox, so a workflow that needs one is off while it asks. */
const onForMacSetup = (data: PageData, picks: Picks, workflow: PageWorkflow) => workflowState(data, picks, workflow).on && !workflow.needs.some((need) => devboxNeeds.includes(need));

/** The settings of the picked packs that apply: each one no workflow lists, or one an active workflow lists. */
export function activeSettings(data: PageData, picks: Picks, pack: PagePack, active = (workflow: PageWorkflow) => workflowState(data, picks, workflow).on) {
  const workflows = picked(data, picks).flatMap((item) => item.workflows);
  const listed = new Set(workflows.flatMap((workflow) => workflow.settings));
  const wanted = new Set(workflows.filter(active).flatMap((workflow) => workflow.settings));
  return pack.settings.filter((setting) => !listed.has(setting.key) || wanted.has(setting.key));
}

const asked = (setting: PackSetting) => setting.ask === "setup" || (setting.ask !== "never" && setting.default === undefined);

function answered(data: PageData, picks: Picks) {
  const settings = picked(data, picks).flatMap((pack) => activeSettings(data, picks, pack));
  return settings.filter((setting) => {
    const value = picks.settings[setting.key];
    return value !== undefined && (value !== setting.default || asked(setting));
  });
}

/** The questions setup on the Mac still asks after it reads the command: the AI plans, then each setting the command leaves open. Settings only a devbox needs are asked when you add a devbox. */
export function questions(data: PageData, all: Picks) {
  const picks = firstSetup(data, all);
  const set = new Set(answered(data, picks).map((setting) => setting.key));
  const open = (setting: PackSetting) => asked(setting) && !data.filledBySetup.includes(setting.key) && !set.has(setting.key);
  const settings = picked(data, picks).flatMap((pack) => activeSettings(data, picks, pack, (workflow) => onForMacSetup(data, picks, workflow))).filter(open);
  const keys = new Set(settings.map((setting) => setting.key));
  const devbox = picked(data, picks).flatMap((pack) => activeSettings(data, picks, pack)).filter((setting) => open(setting) && !keys.has(setting.key));
  return { settings, devbox, devboxStep: !picks.packs.some((pack) => data.ownDevboxPacks.includes(pack)), count: settings.length + 1 };
}

export function settingAsks(open: ReturnType<typeof questions>, setting: PackSetting) {
  if (open.settings.includes(setting)) return "setup asks";
  if (!open.devbox.includes(setting)) return undefined;
  return open.devboxStep ? "setup asks when you add a devbox" : "set it here or later with fleet set";
}

export function setupAsks(data: PageData, picks: Picks) {
  const { count, devbox, devboxStep } = questions(data, picks);
  const asks = `asks ${count} more question${count === 1 ? "" : "s"}`;
  if (!devbox.length) return asks;
  if (devboxStep) return `${asks}, plus ${devbox.length} when you add a devbox`;
  return `${asks}. Set the ${devbox.length === 1 ? "setting" : `${devbox.length} settings`} only a devbox needs in its pack, or later with fleet set`;
}

export function commandFlags(data: PageData, all: Picks): string[] {
  const preset = activePreset(data, all) ?? presetOf(data, all.preset);
  const picks = firstSetup(data, all);
  const base = presetPacks(data, preset, "mac");
  const flags = ["--preset", preset.id];
  for (const name of picks.packs.filter((pack) => !base.includes(pack))) flags.push("--add", name);
  for (const name of base.filter((pack) => !picks.packs.includes(pack))) flags.push("--remove", name);
  const changed = picked(data, picks)
    .flatMap((pack) => pack.workflows)
    .filter((workflow) => chosen(picks, workflow) !== presetChoice(preset, workflow))
    .map((workflow) => `${workflow.id}=${chosen(picks, workflow) ? "on" : "off"}`);
  if (changed.length) flags.push("--workflows", changed.join(","));
  for (const setting of answered(data, picks)) flags.push("--set", `${setting.key}=${String(picks.settings[setting.key])}`);
  return flags;
}

const shellSafe = /^[A-Za-z0-9_.,/:@+=-]+$/;
export const shellQuote = (word: string) => (shellSafe.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

export function commandText(data: PageData, picks: Picks) {
  const flags = commandFlags(data, picks);
  const pairs = flags.flatMap((flag, index) => (index % 2 ? [] : [`${flag} ${shellQuote(flags[index + 1]!)}`]));
  const start = `curl -fsSL https://raw.githubusercontent.com/${data.engineRepo}/main/get.sh | sh -s -- --`;
  return pairs.length === 1 ? `${start} ${pairs[0]}` : [start, ...pairs.map((pair) => `  ${pair}`)].join(" \\\n");
}

/** The picks part of the fleet.json that setup writes from the command. */
export function profileFile(data: PageData, all: Picks) {
  const preset = activePreset(data, all) ?? presetOf(data, all.preset);
  const picks = firstSetup(data, all);
  const flags = commandFlags(data, all);
  const flagged = Object.fromEntries(
    flags
      .flatMap((flag, index) => (flag === "--workflows" ? flags[index + 1]!.split(",") : []))
      .map((pair) => pair.split("="))
      .map(([id, state]) => [id!, state === "on"]),
  );
  const defaults = Object.fromEntries(data.packs.flatMap((pack) => pack.workflows).map((workflow) => [workflow.id, workflow.default]));
  const workflows = Object.fromEntries(Object.entries({ ...preset.workflows, ...flagged }).filter(([id, on]) => id in defaults && defaults[id] !== on));
  const settings = Object.fromEntries(answered(data, picks).map((setting) => [setting.key, picks.settings[setting.key]!]));
  const packs = [...new Set([...presetPacks(data, preset, "mac"), ...picks.packs])].filter((name) => picks.packs.includes(name));
  return { packs, workflows, settings };
}

export const whereLabels: Record<Where, string> = { mac: "Mac only", hub: "Mac plus a hub and a node" };

const setupPrompt = (data: PageData) => `Set up Fleet on this Mac with me. Read https://raw.githubusercontent.com/${data.engineRepo}/main/SETUP.md and follow it step by step.`;

export const promptLabels = {
  intro: "My picks from the Fleet page:",
  where: "Where Fleet runs",
  firstPacks: "Packs on the first setup",
  firstWorkflows: "Workflows on the first setup",
  laterPacks: "Packs once the hub runs",
  laterWorkflows: "Workflows once the hub runs",
  setting: "Setting",
};

function namedWorkflows(data: PageData, picks: Picks, packs: string[], firstSetup: boolean) {
  return data.packs
    .filter((pack) => (pack.always ? firstSetup : packs.includes(pack.name)))
    .flatMap((pack) => pack.workflows)
    .filter((workflow) => chosen(picks, workflow) !== workflow.default || (!firstSetup && workflow.default))
    .map((workflow) => `${workflow.id}=${chosen(picks, workflow) ? "on" : "off"}`);
}

export function promptText(data: PageData, picks: Picks) {
  const { first, later } = setupSplit(data, picks);
  const list = (label: string, items: string[]) => `- ${label}: ${items.join(", ") || "none"}`;
  const optional = (label: string, items: string[]) => (items.length ? [list(label, items)] : []);
  return [
    setupPrompt(data),
    "",
    promptLabels.intro,
    `- ${promptLabels.where}: ${whereLabels[picks.where]}`,
    list(promptLabels.firstPacks, first),
    ...optional(promptLabels.firstWorkflows, namedWorkflows(data, picks, first, true)),
    ...(picks.where === "hub" ? [list(promptLabels.laterPacks, later), ...optional(promptLabels.laterWorkflows, namedWorkflows(data, picks, later, false))] : []),
    ...answered(data, picks).map((setting) => `- ${promptLabels.setting}: ${setting.key}=${String(picks.settings[setting.key])}`),
  ].join("\n");
}
