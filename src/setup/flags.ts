import { isKeptForBoxes, isNodeName } from "../hub/names.ts";
import type { AiPlan, PackSetting, SettingValue } from "../pack/types.ts";

export type SetupFlags = {
  preset?: string;
  add: string[];
  remove: string[];
  workflows: Record<string, boolean>;
  set: Record<string, string>;
  plan?: AiPlan;
  /** An SSH host for the devbox, or "skip". */
  devbox?: string;
  nonInteractive: boolean;
  /** Run by an agent in a chat: ask nothing, as --non-interactive, but wait for each sign-in that the browser finishes. */
  chat: boolean;
};

export class FlagError extends Error {}

const plans: AiPlan[] = ["claude", "codex", "both"];

export function parseSetupFlags(args: string[]): SetupFlags {
  const flags: SetupFlags = { add: [], remove: [], workflows: {}, set: {}, nonInteractive: false, chat: false };
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
    } else if (arg === "--devbox") {
      flags.devbox = value();
      if (!/^[\w][\w.@-]*$/.test(flags.devbox)) throw new FlagError(`--devbox takes an SSH host from ~/.ssh/config, or skip`);
      if (flags.devbox !== "skip") refuseUnusableDevbox(flags.devbox);
    }
    else if (arg === "--non-interactive") flags.nonInteractive = true;
    else if (arg === "--chat") flags.nonInteractive = flags.chat = true;
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

export function refuseUnusableDevbox(host: string) {
  if (!isNodeName(host)) throw new FlagError(`${host} is not a name the hub can use. Give the devbox an SSH name in ~/.ssh/config of lowercase letters, digits, dots and dashes, starting with a letter or a digit.`);
  if (isKeptForBoxes(host)) throw new FlagError(`${host} is a pool box name. Names that start with box- are kept for the boxes the hub starts; give the devbox another SSH name.`);
}
