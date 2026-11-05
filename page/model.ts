import type { Need, PackSetting, SettingValue } from "../src/pack/types.ts";

export type PageWorkflow = {
  id: string;
  name: string;
  sentence: string;
  needs: Need[];
  default: boolean;
  settings: string[];
  moment?: { time: string; title: string; body: string; words?: string[]; night?: boolean };
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

export type PagePreset = { id: string; name: string; blurb: string; packs: string[]; workflows: Record<string, boolean> };

export type PageData = {
  engineRepo: string;
  defaultPreset: string;
  filledBySetup: string[];
  presets: PagePreset[];
  packs: PagePack[];
  /** Packs from a team's private source, which setup ticks in every preset. */
  teamPacks: string[];
  concepts: Array<{ word: string; note: string }>;
  /** Needs that hold only while a pack is on, such as hub. */
  needPacks: Partial<Record<Need, string>>;
  needLabels: Partial<Record<Need, string>>;
  teamNote: string;
};

export type Picks = { preset: string; packs: string[]; workflows: Record<string, boolean>; settings: Record<string, SettingValue> };

export type MomentState = { on: true } | { on: false; fix: { pack: string } | { workflow: string } };

const packOf = (data: PageData, name: string) => data.packs.find((pack) => pack.name === name);
const presetOf = (data: PageData, id: string) => data.presets.find((preset) => preset.id === id) ?? data.presets.find((preset) => preset.id === data.defaultPreset)!;
const presetPacks = (data: PageData, preset: PagePreset) => [...new Set([...preset.packs, ...data.teamPacks])];
const picked = (data: PageData, picks: Picks) => data.packs.filter((pack) => pack.always || picks.packs.includes(pack.name));
const sameSet = (left: string[], right: string[]) => left.length === right.length && left.every((item) => right.includes(item));

export const chosen = (picks: Pick<Picks, "workflows">, workflow: PageWorkflow) => picks.workflows[workflow.id] ?? workflow.default;

export function presetPicks(data: PageData, id: string, settings: Picks["settings"] = {}): Picks {
  const preset = presetOf(data, id);
  return { preset: preset.id, packs: presetPacks(data, preset), workflows: { ...preset.workflows }, settings };
}

export function togglePack(data: PageData, picks: Picks, name: string): Picks {
  if (packOf(data, name)?.always) return picks;
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
  return { ...picks, packs: data.packs.map((pack) => pack.name).filter((pack) => packs.has(pack)) };
}

export function toggleWorkflow(data: PageData, picks: Picks, id: string): Picks {
  const workflow = data.packs.flatMap((pack) => pack.workflows).find((item) => item.id === id);
  if (!workflow) return picks;
  return { ...picks, workflows: { ...picks.workflows, [id]: !chosen(picks, workflow) } };
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

export function momentState(data: PageData, picks: Picks, workflow: PageWorkflow, pack = data.packs.find((item) => item.workflows.includes(workflow))?.name): MomentState {
  const owner = pack ? packOf(data, pack) : undefined;
  if (owner && !owner.always && !picks.packs.includes(owner.name)) return { on: false, fix: { pack: owner.name } };
  if (!chosen(picks, workflow)) return { on: false, fix: { workflow: workflow.id } };
  const missing = missingPack(data, picks, workflow);
  return missing ? { on: false, fix: { pack: missing } } : { on: true };
}

const presetChoice = (preset: PagePreset, workflow: PageWorkflow) => preset.workflows[workflow.id] ?? workflow.default;

export function activePreset(data: PageData, picks: Picks) {
  const matches = (preset: PagePreset) =>
    sameSet(presetPacks(data, preset), picks.packs) &&
    picked(data, picks).every((pack) => pack.workflows.every((workflow) => chosen(picks, workflow) === presetChoice(preset, workflow)));
  const own = presetOf(data, picks.preset);
  return matches(own) ? own : data.presets.find(matches);
}

const devboxNeeds: Need[] = ["devbox", "always-on devbox"];

/** Setup on the Mac plans before it asks about a devbox, so a workflow that needs one is off while it asks. */
const onForMacSetup = (data: PageData, picks: Picks, workflow: PageWorkflow) => momentState(data, picks, workflow).on && !workflow.needs.some((need) => devboxNeeds.includes(need));

/** The settings of the picked packs that apply: each one no workflow lists, or one an active workflow lists. */
export function activeSettings(data: PageData, picks: Picks, pack: PagePack, active = (workflow: PageWorkflow) => momentState(data, picks, workflow).on) {
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
export function questions(data: PageData, picks: Picks) {
  const set = new Set(answered(data, picks).map((setting) => setting.key));
  const open = (setting: PackSetting) => asked(setting) && !data.filledBySetup.includes(setting.key) && !set.has(setting.key);
  const settings = picked(data, picks).flatMap((pack) => activeSettings(data, picks, pack, (workflow) => onForMacSetup(data, picks, workflow))).filter(open);
  const keys = new Set(settings.map((setting) => setting.key));
  const devbox = picked(data, picks).flatMap((pack) => activeSettings(data, picks, pack)).filter((setting) => open(setting) && !keys.has(setting.key));
  return { settings, devbox, count: settings.length + 1 };
}

export function setupAsks(data: PageData, picks: Picks) {
  const { count, devbox } = questions(data, picks);
  return `asks ${count} more question${count === 1 ? "" : "s"}${devbox.length ? `, plus ${devbox.length} when you add a devbox` : ""}`;
}

export function commandFlags(data: PageData, picks: Picks): string[] {
  const preset = activePreset(data, picks) ?? presetOf(data, picks.preset);
  const base = presetPacks(data, preset);
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
export function profileFile(data: PageData, picks: Picks) {
  const preset = activePreset(data, picks) ?? presetOf(data, picks.preset);
  const flags = commandFlags(data, picks);
  const flagged = Object.fromEntries(
    flags
      .flatMap((flag, index) => (flag === "--workflows" ? flags[index + 1]!.split(",") : []))
      .map((pair) => pair.split("="))
      .map(([id, state]) => [id!, state === "on"]),
  );
  const defaults = Object.fromEntries(data.packs.flatMap((pack) => pack.workflows).map((workflow) => [workflow.id, workflow.default]));
  const workflows = Object.fromEntries(Object.entries({ ...preset.workflows, ...flagged }).filter(([id, on]) => id in defaults && defaults[id] !== on));
  const settings = Object.fromEntries(answered(data, picks).map((setting) => [setting.key, picks.settings[setting.key]!]));
  const packs = [...new Set([...presetPacks(data, preset), ...picks.packs])].filter((name) => picks.packs.includes(name));
  return { packs, workflows, settings };
}
