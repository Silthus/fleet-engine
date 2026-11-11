import type { AiPlan, AvailableSource, LoadedPack, PackManifest, PackSetting, Preset, ProfileFile, SettingValue } from "../pack/types.ts";
import { workflowDefaults, workflowOverrides } from "../profile/profile.ts";
import { FlagError, hasPicks, parseSettingValue, type SetupFlags } from "./flags.ts";
import type { Step, StepOutcome } from "./runner.ts";
import { teamSources } from "./signins.ts";
import type { Terminal } from "./terminal.ts";

export type Draft = Partial<Pick<ProfileFile, "packs" | "plan" | "settings" | "workflows" | "sources">>;

export type Catalog = {
  presets: Preset[];
  /** The engine source first, then each team source. */
  sources: AvailableSource[];
  packs: LoadedPack[];
  /** Packs from team sources: setup offers them only to the team's members, and ticks them by default. */
  teamPacks: string[];
  /** True once GitHub sign-in has shown which team sources this person may use. */
  teamsKnown: boolean;
  add(source: AvailableSource): void;
};

/** Team sources that GitHub sign-in has yet to decide on: their packs may name more workflows and settings. */
function pendingTeams(catalog: Pick<Catalog, "sources" | "teamsKnown">) {
  return catalog.teamsKnown ? [] : teamSources.map(({ source }) => source.name).filter((name) => !catalog.sources.some((loaded) => loaded.ref.name === name));
}

const laterWorkflow = (catalog: Pick<Catalog, "sources" | "teamsKnown">) => pendingTeams(catalog).length > 0;
const laterSetting = (catalog: Pick<Catalog, "sources" | "teamsKnown">, key: string) => pendingTeams(catalog).some((name) => key.startsWith(`${name}.`));

/** True when some flag names a workflow or setting that only a team pack, still to be fetched, can have. */
export function waitsForTeams(flags: SetupFlags, catalog: Catalog) {
  const manifests = catalog.packs.map((pack) => pack.manifest);
  const known = workflowDefaults(manifests);
  const keys = new Set(manifests.flatMap((manifest) => (manifest.settings ?? []).map((setting) => setting.key)));
  return Object.keys(flags.workflows).some((id) => !Object.hasOwn(known, id) && laterWorkflow(catalog)) || Object.keys(flags.set).some((key) => !keys.has(key) && laterSetting(catalog, key));
}

export type QuestionContext = {
  terminal: Terminal;
  flags: SetupFlags;
  catalog: Catalog;
  draft: Draft;
  /** Saves answers to the machine file's draft before the step counts as done. */
  answer(fields: Draft): Promise<void>;
  /** This machine's IANA time zone, such as Europe/Berlin, when it has one. */
  timeZone: string | undefined;
};

/** The value of the longest prefix of the time zone in the setting's defaultByTimeZone. */
export function timeZoneDefault(setting: PackSetting, timeZone: string | undefined) {
  if (!timeZone) return undefined;
  const prefix = Object.keys(setting.defaultByTimeZone ?? {})
    .filter((key) => timeZone.startsWith(key))
    .sort((left, right) => right.length - left.length)[0];
  return prefix === undefined ? undefined : setting.defaultByTimeZone![prefix];
}

export const defaultPreset = "everyday";

/** Settings that setup fills itself, so it never asks them. */
export const filledBySetup = new Set(["memory.repo"]);

const planLabels: Record<AiPlan, string> = { both: "Claude and ChatGPT", claude: "Claude", codex: "ChatGPT" };

export function packsStep(context: QuestionContext): Step {
  return { id: "packs", title: "Pick your packs", minutes: 1, kind: "question", run: () => askPacks(context) };
}

export function plansStep(context: QuestionContext): Step {
  return { id: "plans", title: "Your AI plans", minutes: 0.5, kind: "question", run: () => askPlan(context) };
}

export function settingSteps(context: QuestionContext, asked: PackSetting[]): Step[] {
  return asked
    .filter((setting) => !filledBySetup.has(setting.key))
    .map((setting) => ({ id: `setting:${setting.key}`, title: setting.question, minutes: 0.5, kind: "question" as const, run: () => askSetting(context, setting) }));
}

function presetPacks(preset: Preset, catalog: Catalog) {
  return [...new Set([...preset.packs, ...catalog.teamPacks])];
}

export function choosablePacks(catalog: Catalog) {
  const order = [...new Set(catalog.presets.flatMap((preset) => preset.packs))];
  const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
  return catalog.packs
    .map((pack) => pack.manifest)
    .filter((manifest) => manifest.name !== "base")
    .sort((left, right) => rank(left.name) - rank(right.name));
}

/** Turns --add, --remove and --workflows into packs and workflow overrides, on top of the saved picks, or of a preset on the first run or with --preset. Checks every name. */
export function picksFrom(flags: SetupFlags, catalog: Catalog, saved: Draft = {}): Required<Pick<Draft, "packs" | "workflows">> {
  const presetId = flags.preset ?? defaultPreset;
  const preset = catalog.presets.find((item) => item.id === presetId);
  if (!preset) throw new FlagError(`--preset ${presetId}: choose ${catalog.presets.map((item) => item.id).join(", ")}`);
  const start = saved.packs && flags.preset === undefined ? { packs: saved.packs, workflows: saved.workflows ?? {} } : { packs: presetPacks(preset, catalog), workflows: preset.workflows };
  const names = new Set([...choosablePacks(catalog).map((manifest) => manifest.name), ...teamSources.map((team) => team.source.name)]);
  for (const name of [...flags.add, ...flags.remove]) {
    if (name === "base") throw new FlagError("the base pack is always on");
    if (!names.has(name)) throw new FlagError(`no pack named ${name}. Packs: ${[...names].join(", ")}`);
  }
  const packs = [...new Set([...start.packs, ...flags.add])].filter((name) => !flags.remove.includes(name));
  const [unmet] = unmetNeeds(packs, catalog);
  if (unmet) throw new FlagError(`${title(unmet.pack, catalog.packs)} needs ${unmet.needs.map((name) => title(name, catalog.packs)).join(", ")}. Add ${unmet.needs.join(", ")}, or remove ${unmet.pack}.`);
  const manifests = catalog.packs.map((pack) => pack.manifest);
  const known = workflowDefaults(manifests);
  for (const id of Object.keys(flags.workflows)) if (!Object.hasOwn(known, id) && !laterWorkflow(catalog)) throw new FlagError(`--workflows: no workflow named ${id}`);
  const unloaded = Object.fromEntries(Object.entries(start.workflows).filter(([id]) => !Object.hasOwn(known, id)));
  return { packs, workflows: { ...unloaded, ...workflowOverrides({ ...start.workflows, ...flags.workflows }, manifests) } };
}

/** Picked packs whose required packs are not picked. */
export function unmetNeeds(packs: string[], catalog: Pick<Catalog, "packs">) {
  return catalog.packs
    .map((pack) => pack.manifest)
    .filter((manifest) => packs.includes(manifest.name))
    .map((manifest) => ({ pack: manifest.name, needs: (manifest.requires ?? []).filter((name) => name !== "base" && !packs.includes(name)) }))
    .filter((item) => item.needs.length);
}

export function settingsFrom(flags: SetupFlags, catalog: Pick<Catalog, "packs"> & Partial<Pick<Catalog, "sources" | "teamsKnown">>): Record<string, SettingValue> {
  const settings = catalog.packs.flatMap((pack) => pack.manifest.settings ?? []);
  const later = (key: string) => laterSetting({ sources: catalog.sources ?? [], teamsKnown: catalog.teamsKnown ?? true }, key);
  return Object.fromEntries(
    Object.entries(flags.set).flatMap(([key, raw]) => {
      const setting = settings.find((item) => item.key === key);
      if (!setting && later(key)) return [];
      if (!setting) throw new FlagError(`--set ${key}: no pack has this setting`);
      return [[key, parseSettingValue(setting, raw)]];
    }),
  );
}

async function askPacks(context: QuestionContext): Promise<StepOutcome> {
  const { terminal, flags, catalog, draft } = context;
  const last = draft.packs && !hasPicks(flags) ? { packs: draft.packs, workflows: draft.workflows ?? {} } : undefined;
  const picked = last ?? picksFrom(flags, catalog, draft);
  const show = (picks: typeof picked) => terminal.print(`  ✓ ${packList(picks.packs, catalog)}`);
  if (flags.nonInteractive) return context.answer(picked).then(() => show(picked));
  terminal.print("? Which packs do you want?");
  terminal.print("  A pack is a set of workflows. Base is always on. Read what each does on the explainer page.");
  if (last || hasPicks(flags)) {
    terminal.print(`  From your ${last ? "last answer" : "command"}: ${packList(picked.packs, catalog)}`);
    const changed = Object.entries(flags.workflows).map(([id, on]) => `${id} ${on ? "on" : "off"}`);
    if (changed.length) terminal.print(`  Workflows: ${changed.join(", ")}`);
    const reply = await askUntil(terminal, "Press ↵ to keep them, or e to change them: ", (text) => (text === "" ? "keep" : text.toLowerCase() === "e" ? "edit" : undefined));
    if (reply === "keep") return context.answer(picked).then(() => show(picked));
  }
  const presets = [...catalog.presets].sort((left, right) => Number(right.id === defaultPreset) - Number(left.id === defaultPreset));
  const lines = [...presets.map((preset) => `${preset.name}  ${packList(presetPacks(preset, catalog), catalog)}`), "One by one"];
  const fallback = presets.findIndex((preset) => preset.id === defaultPreset);
  const index = await chooseFrom(terminal, lines, fallback, presets[fallback]!.name);
  const chosen = index < presets.length ? { packs: presetPacks(presets[index]!, catalog), workflows: workflowOverrides(presets[index]!.workflows, catalog.packs.map((pack) => pack.manifest)) } : { packs: await oneByOne(terminal, catalog, picked.packs), workflows: picked.workflows };
  await context.answer(chosen);
  show(chosen);
}

async function oneByOne(terminal: Terminal, catalog: Catalog, current: string[]) {
  const packs: string[] = [];
  for (const manifest of choosablePacks(catalog)) {
    const on = current.includes(manifest.name);
    terminal.print(`  ${packTitle(manifest)}: ${manifest.summary}`);
    if (await yesNo(terminal, "  Turn it on?", on)) packs.push(manifest.name);
  }
  for (const unmet of unmetNeeds(packs, catalog)) {
    terminal.print(`  ${title(unmet.pack, catalog.packs)} needs ${unmet.needs.map((name) => title(name, catalog.packs)).join(", ")}, so ${unmet.needs.length === 1 ? "it is" : "they are"} on too.`);
    packs.push(...unmet.needs.filter((name) => !packs.includes(name)));
  }
  return packs;
}

async function askPlan(context: QuestionContext): Promise<StepOutcome> {
  const { terminal, flags, draft } = context;
  const show = (plan: AiPlan) => terminal.print(`  ✓ ${planLabels[plan]}`);
  if (flags.plan || flags.nonInteractive) {
    const plan = flags.plan ?? draft.plan ?? "both";
    return context.answer({ plan }).then(() => show(plan));
  }
  terminal.print("? Which AI plans do you pay for?");
  terminal.print("  You get only the sign-ins and model defaults that match.");
  const order: AiPlan[] = ["both", "claude", "codex"];
  const fallback = order.indexOf(draft.plan ?? "both");
  const index = await chooseFrom(terminal, order.map((plan) => planLabels[plan]), fallback, planLabels[order[fallback]!]);
  await context.answer({ plan: order[index] });
  show(order[index]!);
}

async function askSetting(context: QuestionContext, setting: PackSetting): Promise<StepOutcome> {
  const { terminal, flags, draft } = context;
  const save = async (value: SettingValue) => {
    await context.answer({ settings: { ...draft.settings, [setting.key]: value } });
    terminal.print(`  ✓ ${label(setting, value)}`);
  };
  if (flags.set[setting.key] !== undefined) return save(parseSettingValue(setting, flags.set[setting.key]!));
  const saved = draft.settings?.[setting.key];
  if (flags.nonInteractive) {
    const fallback = saved ?? setting.default;
    if (fallback !== undefined) return terminal.print(`  ✓ ${label(setting, fallback)}`);
    if (setting.optional) return terminal.print(`  ✓ Skipped. Set it later with fleet set ${setting.key}=<value>.`);
    return "unanswered";
  }
  const fallback = saved ?? timeZoneDefault(setting, context.timeZone) ?? setting.default;
  terminal.print(`? ${setting.question}`);
  if (setting.type === "choice" && setting.choices?.length) {
    const preferred = setting.choices.findIndex((choice) => choice.value === fallback);
    const skip = setting.optional && preferred < 0;
    const index = await chooseFrom(terminal, setting.choices.map((choice) => choice.label), preferred, preferred >= 0 ? setting.choices[preferred]!.label : undefined, skip);
    if (index < 0) return terminal.print(`  ✓ Skipped. Set it later with fleet set ${setting.key}=<value>.`);
    return save(setting.choices[index]!.value);
  }
  const hint = fallback !== undefined ? `Press ↵ for ${String(fallback)}, or type a value: ` : setting.optional ? `Press ↵ to skip, or type a value: ` : "Type a value: ";
  const value = await askUntil(terminal, hint, (text) => {
    if (text === "") return fallback ?? (setting.optional ? null : undefined);
    try {
      return parseSettingValue(setting, text);
    } catch (error) {
      terminal.print(`  ${(error as Error).message}.`);
      return undefined;
    }
  });
  if (value === null) return terminal.print(`  ✓ Skipped. Set it later with fleet set ${setting.key}=<value>.`);
  return save(value);
}

async function chooseFrom(terminal: Terminal, lines: string[], fallback: number, fallbackLabel?: string, skip = false) {
  lines.forEach((line, index) => terminal.print(`  ${index + 1}) ${line}${index === fallback ? " (default)" : ""}`));
  const prompt = fallbackLabel ? `Press ↵ for ${fallbackLabel}, or type a number: ` : skip ? "Press ↵ to skip, or type a number: " : "Type a number: ";
  return askUntil(terminal, prompt, (text) => {
    if (text === "") return fallbackLabel ? fallback : skip ? -1 : undefined;
    const number = Number(text);
    return Number.isInteger(number) && number >= 1 && number <= lines.length ? number - 1 : undefined;
  });
}

async function yesNo(terminal: Terminal, question: string, fallback: boolean) {
  return askUntil(terminal, `${question} ${fallback ? "(Y/n)" : "(y/N)"} `, (text) => {
    const answer = text.toLowerCase();
    return answer === "" ? fallback : ["y", "yes"].includes(answer) ? true : ["n", "no"].includes(answer) ? false : undefined;
  });
}

async function askUntil<T>(terminal: Terminal, prompt: string, read: (text: string) => T | undefined): Promise<T> {
  for (;;) {
    const value = read(await terminal.ask(prompt));
    if (value !== undefined) return value;
  }
}

function label(setting: PackSetting, value: SettingValue) {
  const choice = setting.choices?.find((item) => item.value === value);
  return choice ? choice.label : String(value);
}

export function packList(names: string[], catalog: Catalog) {
  const known = new Set(catalog.packs.map((pack) => pack.manifest.name));
  return names.length ? names.map((name) => (known.has(name) ? title(name, catalog.packs) : name)).join(", ") : "Base only";
}

export function packTitle(manifest: Pick<PackManifest, "name" | "title">) {
  return manifest.title ?? manifest.name.charAt(0).toUpperCase() + manifest.name.slice(1);
}

export function title(name: string, packs: Array<Pick<LoadedPack, "manifest">>) {
  return packTitle(packs.find((pack) => pack.manifest.name === name)?.manifest ?? { name });
}
