import type { AiPlan, PackSetting, SettingValue } from "../pack/types.ts";

export type SetupFlags = {
  preset?: string;
  add: string[];
  remove: string[];
  workflows: Record<string, boolean>;
  set: Record<string, string>;
  plan?: AiPlan;
  nonInteractive: boolean;
};

export class FlagError extends Error {}

const plans: AiPlan[] = ["claude", "codex", "both"];

export function parseSetupFlags(args: string[]): SetupFlags {
  const flags: SetupFlags = { add: [], remove: [], workflows: {}, set: {}, nonInteractive: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = () => {
      const next = args[++index];
      if (next === undefined || next.startsWith("--")) throw new FlagError(`${arg} needs a value`);
      return next;
    };
    if (arg === "--preset") flags.preset = value();
    else if (arg === "--add") flags.add.push(value());
    else if (arg === "--remove") flags.remove.push(value());
    else if (arg === "--workflows") Object.assign(flags.workflows, parseWorkflows(value()));
    else if (arg === "--set") {
      const [key, raw] = splitPair(value(), "--set takes pack.key=value");
      if (!/^[a-z0-9-]+\.[A-Za-z0-9.-]+$/.test(key)) throw new FlagError(`--set ${key}: name a setting as pack.key`);
      flags.set[key] = raw;
    } else if (arg === "--plan") {
      const plan = value();
      if (!plans.includes(plan as AiPlan)) throw new FlagError(`--plan takes claude, codex, or both`);
      flags.plan = plan as AiPlan;
    } else if (arg === "--non-interactive") flags.nonInteractive = true;
    else throw new FlagError(`unknown option ${arg}`);
  }
  return flags;
}

export function hasPicks(flags: SetupFlags) {
  return flags.preset !== undefined || flags.add.length > 0 || flags.remove.length > 0 || Object.keys(flags.workflows).length > 0;
}

function parseWorkflows(text: string) {
  const choices: Record<string, boolean> = {};
  for (const item of text.split(",").filter(Boolean)) {
    const [id, state] = splitPair(item, "--workflows takes id=on or id=off, separated by commas");
    if (state !== "on" && state !== "off") throw new FlagError(`--workflows ${id}: use on or off`);
    choices[id] = state === "on";
  }
  return choices;
}

function splitPair(text: string, usage: string): [string, string] {
  const at = text.indexOf("=");
  if (at <= 0) throw new FlagError(usage);
  return [text.slice(0, at), text.slice(at + 1)];
}

const yes = ["true", "on", "yes", "y"];
const no = ["false", "off", "no", "n"];

/** Reads a typed setting value from text, the same way for flags, questions, and fleet set. */
export function parseSettingValue(setting: PackSetting, raw: string): SettingValue {
  const text = raw.trim();
  if (setting.type === "number") {
    const number = Number(text);
    if (text === "" || !Number.isFinite(number)) throw new FlagError(`${setting.key} takes a number`);
    return number;
  }
  if (setting.type === "boolean") {
    if (yes.includes(text.toLowerCase())) return true;
    if (no.includes(text.toLowerCase())) return false;
    throw new FlagError(`${setting.key} takes on or off`);
  }
  if (setting.type === "choice") {
    const choice = setting.choices?.find((item) => String(item.value) === text);
    if (!choice) throw new FlagError(`${setting.key} takes one of ${(setting.choices ?? []).map((item) => String(item.value)).join(", ")}`);
    return choice.value;
  }
  if (text === "") throw new FlagError(`${setting.key} needs a value`);
  return text;
}
