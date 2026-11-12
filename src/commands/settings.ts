import type { PackManifest, PackSetting, SettingValue } from "../pack/types.ts";
import { FlagError, parseSettingValue } from "../setup/flags.ts";
import { activePacks, type ChangeContext, manifests, saveAndApply } from "./change.ts";

/** Lists the settings of the packs that are on, with where each value comes from. */
export function settingsCommand(args: string[], context: Pick<ChangeContext, "plan" | "packs" | "profile" | "print">): number {
  if (args.length) throw new FlagError("usage: fleet settings. Change a setting with fleet set <pack.key>=<value>.");
  const packs = listedSettings(activePacks(context));
  if (!packs.length) return context.print("The packs you have on have no settings."), 0;
  for (const manifest of packs) {
    context.print(`${manifest.name}:`);
    for (const setting of manifest.settings) {
      context.print(`  ${setting.key} = ${shown(setting, context)}`);
      context.print(`      ${setting.question}`);
    }
  }
  context.print("");
  context.print("Change one with fleet set <pack.key>=<value>.");
  return 0;
}

function listedSettings(manifests: PackManifest[]) {
  const firstPack = new Map<string, string>();
  for (const manifest of manifests) for (const setting of manifest.settings ?? []) if (!firstPack.has(setting.key)) firstPack.set(setting.key, manifest.name);
  return manifests
    .map((manifest) => ({ name: manifest.name, settings: (manifest.settings ?? []).filter((setting) => firstPack.get(setting.key) === manifest.name) }))
    .filter((manifest) => manifest.settings.length);
}

function shown(setting: PackSetting, context: Pick<ChangeContext, "plan" | "packs" | "profile" | "print">) {
  const value = context.plan.settings[setting.key];
  if (value === undefined) return context.plan.unanswered.some((item) => item.key === setting.key) ? "not set yet, Fleet needs it" : "not set";
  if (setting.key in context.profile.settings) return String(value);
  return `${String(value)} (default)`;
}

/** Changes settings: fleet set pack.key=value... */
export async function setCommand(args: string[], context: ChangeContext): Promise<number> {
  if (!args.length) throw new FlagError("usage: fleet set <pack.key>=<value>...");
  const settings = manifests(context).flatMap((manifest) => (manifest.settings ?? []).map((setting) => ({ ...setting, pack: manifest.name })));
  const on = new Set(activePacks(context).map((manifest) => manifest.name));
  const values: Record<string, SettingValue> = {};
  const off = new Set<string>();
  for (const arg of args.filter((item) => item !== "--set")) {
    const at = arg.indexOf("=");
    if (at <= 0) throw new FlagError(`${arg}: write it as pack.key=value`);
    const key = arg.slice(0, at);
    const setting = settings.find((item) => item.key === key);
    if (!setting) throw new FlagError(`${key}: no pack has this setting. See them with fleet settings.`);
    values[key] = parseSettingValue(setting, arg.slice(at + 1));
    if (!on.has(setting.pack)) off.add(setting.pack);
  }
  const code = await saveAndApply(context, { settings: values }, Object.keys(values).join(", "));
  for (const pack of off) context.print(`The ${pack} pack is off, so its setting waits until you turn it on with fleet packs --add ${pack}.`);
  return code;
}
