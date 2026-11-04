import type { AiPlan, LoadedPack, PackSetting, Preset, ProfileFile, SettingValue } from "../pack/types.ts";
import { workflowDefaults, workflowOverrides } from "../profile/profile.ts";
import { FlagError, hasPicks, parseSettingValue, type SetupFlags } from "./flags.ts";
import type { Step, StepOutcome } from "./runner.ts";
import type { Terminal } from "./terminal.ts";

export type Draft = Partial<Pick<ProfileFile, "packs" | "plan" | "settings" | "workflows" | "sources">>;

export type Catalog = { packs: LoadedPack[]; presets: Preset[] };

export type QuestionContext = {
  terminal: Terminal;
  flags: SetupFlags;
  catalog: Catalog;
  draft: Draft;
  /** Saves answers to the machine file's draft before the step counts as done. */
  answer(fields: Draft): Promise<void>;
};

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

export function choosablePacks(catalog: Catalog) {
  const order = [...new Set(catalog.presets.flatMap((preset) => preset.packs))];
  const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
  return catalog.packs
    .map((pack) => pack.manifest)
    .filter((manifest) => manifest.name !== "base")
    .sort((left, right) => rank(left.name) - rank(right.name));
}

/** Turns a preset plus --add, --remove and --workflows into packs and workflow overrides, and checks every name. */
export function picksFrom(flags: SetupFlags, catalog: Catalog): Required<Pick<Draft, "packs" | "workflows">> {
  const presetId = flags.preset ?? defaultPreset;
  const preset = catalog.presets.find((item) => item.id === presetId);
  if (!preset) throw new FlagError(`--preset ${presetId}: choose ${catalog.presets.map((item) => item.id).join(", ")}`);
  const names = new Set(choosablePacks(catalog).map((manifest) => manifest.name));
  for (const name of [...flags.add, ...flags.remove]) {
    if (name === "base") throw new FlagError("the base pack is always on");
    if (!names.has(name)) throw new FlagError(`no pack named ${name}. Packs: ${[...names].join(", ")}`);
  }
  const packs = [...new Set([...preset.packs, ...flags.add])].filter((name) => !flags.remove.includes(name));
  const manifests = catalog.packs.map((pack) => pack.manifest);
  const known = workflowDefaults(manifests);
  for (const id of Object.keys(flags.workflows)) if (!(id in known)) throw new FlagError(`--workflows: no workflow named ${id}`);
  return { packs, workflows: workflowOverrides({ ...preset.workflows, ...flags.workflows }, manifests) };
}

export function settingsFrom(flags: SetupFlags, catalog: Catalog): Record<string, SettingValue> {
  const settings = catalog.packs.flatMap((pack) => pack.manifest.settings ?? []);
  return Object.fromEntries(
    Object.entries(flags.set).map(([key, raw]) => {
      const setting = settings.find((item) => item.key === key);
      if (!setting) throw new FlagError(`--set ${key}: no pack has this setting`);
      return [key, parseSettingValue(setting, raw)];
    }),
  );
}

async function askPacks(context: QuestionContext): Promise<StepOutcome> {
  const { terminal, flags, catalog } = context;
  const picked = picksFrom(flags, catalog);
  const show = (picks: typeof picked) => terminal.print(`  ✓ ${packList(picks.packs, catalog)}`);
  if (flags.nonInteractive) return context.answer(picked).then(() => show(picked));
  terminal.print("? Which packs do you want?");
  terminal.print("  A pack is a set of workflows. Base is always on. Read what each does on the explainer page.");
  if (hasPicks(flags)) {
    terminal.print(`  From your command: ${packList(picked.packs, catalog)}`);
    const changed = Object.entries(flags.workflows).map(([id, on]) => `${id} ${on ? "on" : "off"}`);
    if (changed.length) terminal.print(`  Workflows: ${changed.join(", ")}`);
    const reply = await askUntil(terminal, "Press ↵ to keep them, or e to change them: ", (text) => (text === "" ? "keep" : text.toLowerCase() === "e" ? "edit" : undefined));
    if (reply === "keep") return context.answer(picked).then(() => show(picked));
  }
  const presets = [...catalog.presets].sort((left, right) => Number(right.id === defaultPreset) - Number(left.id === defaultPreset));
  const lines = [...presets.map((preset) => `${preset.name}  ${packList(preset.packs, catalog)}`), "One by one"];
  const fallback = presets.findIndex((preset) => preset.id === defaultPreset);
  const index = await chooseFrom(terminal, lines, fallback, presets[fallback]!.name);
  const chosen = index < presets.length ? { packs: presets[index]!.packs, workflows: workflowOverrides(presets[index]!.workflows, catalog.packs.map((pack) => pack.manifest)) } : await oneByOne(terminal, catalog, picked.packs);
  await context.answer(chosen);
  show(chosen);
}

async function oneByOne(terminal: Terminal, catalog: Catalog, current: string[]) {
  const packs: string[] = [];
  for (const manifest of choosablePacks(catalog)) {
    const on = current.includes(manifest.name);
    terminal.print(`  ${title(manifest.name)}: ${manifest.summary}`);
    if (await yesNo(terminal, "  Turn it on?", on)) packs.push(manifest.name);
  }
  return { packs, workflows: {} };
}

async function askPlan(context: QuestionContext): Promise<StepOutcome> {
  const { terminal, flags } = context;
  const show = (plan: AiPlan) => terminal.print(`  ✓ ${planLabels[plan]}`);
  if (flags.plan || flags.nonInteractive) {
    const plan = flags.plan ?? "both";
    return context.answer({ plan }).then(() => show(plan));
  }
  terminal.print("? Which AI plans do you pay for?");
  terminal.print("  You get only the sign-ins and model defaults that match.");
  const order: AiPlan[] = ["both", "claude", "codex"];
  const index = await chooseFrom(terminal, order.map((plan) => planLabels[plan]), 0, planLabels.both);
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
  if (flags.nonInteractive) {
    if (setting.default !== undefined) return terminal.print(`  ✓ ${label(setting, setting.default)}`);
    if (setting.optional) return terminal.print(`  ✓ Skipped. Set it later with fleet set ${setting.key}=<value>.`);
    return "unanswered";
  }
  terminal.print(`? ${setting.question}`);
  if (setting.type === "choice" && setting.choices?.length) {
    const fallback = setting.choices.findIndex((choice) => choice.value === setting.default);
    const skip = setting.optional && fallback < 0;
    const index = await chooseFrom(terminal, setting.choices.map((choice) => choice.label), fallback, fallback >= 0 ? setting.choices[fallback]!.label : undefined, skip);
    if (index < 0) return terminal.print(`  ✓ Skipped. Set it later with fleet set ${setting.key}=<value>.`);
    return save(setting.choices[index]!.value);
  }
  const hint = setting.default !== undefined ? `Press ↵ for ${String(setting.default)}, or type a value: ` : setting.optional ? `Press ↵ to skip, or type a value: ` : "Type a value: ";
  const value = await askUntil(terminal, hint, (text) => {
    if (text === "") return setting.default ?? (setting.optional ? null : undefined);
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
  return names.length ? names.map((name) => (known.has(name) ? title(name) : name)).join(", ") : "Base only";
}

export function title(name: string) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
