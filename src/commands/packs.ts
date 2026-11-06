import { activeChoices, workflowDefaults, workflowOverrides } from "../profile/profile.ts";
import { FlagError, parseSetupFlags } from "../setup/flags.ts";
import { settingsFrom, title, unmetNeeds } from "../setup/questions.ts";
import { activePacks, type ChangeContext, manifests, saveAndApply } from "./change.ts";

const usage = "fleet packs [--add <pack>]... [--remove <pack>]... [--workflows <id=on|off,...>] [--set <pack.key=value>]...";

/** Lists the packs, or turns packs and workflows on and off. */
export async function packsCommand(args: string[], context: ChangeContext): Promise<number> {
  const flags = parseSetupFlags(args);
  if (flags.preset !== undefined || flags.plan !== undefined || flags.devbox !== undefined || flags.nonInteractive) throw new FlagError(`usage: ${usage}`);
  if (!flags.add.length && !flags.remove.length && !Object.keys(flags.workflows).length && !Object.keys(flags.set).length) return listPacks(context), 0;

  const known = manifests(context);
  const names = new Set(known.filter((manifest) => manifest.name !== "base").map((manifest) => manifest.name));
  for (const name of [...flags.add, ...flags.remove]) {
    if (name === "base") throw new FlagError("the base pack is always on");
    if (!names.has(name)) throw new FlagError(`no pack named ${name}. Packs: ${[...names].join(", ")}`);
  }
  const defaults = workflowDefaults(known);
  for (const id of Object.keys(flags.workflows)) if (!Object.hasOwn(defaults, id)) throw new FlagError(`--workflows: no workflow named ${id}`);
  const settings = settingsFrom(flags, { packs: context.packs });

  const packs = [...new Set([...context.profile.packs, ...flags.add])].filter((name) => !flags.remove.includes(name));
  const [unmet] = unmetNeeds(packs, { packs: context.packs });
  if (unmet) throw new FlagError(`${title(unmet.pack, context.packs)} needs ${unmet.needs.map((name) => title(name, context.packs)).join(", ")}. Add ${unmet.needs.join(", ")}, or remove ${unmet.pack}.`);
  const elsewhere = Object.fromEntries(Object.entries(context.profile.workflows).filter(([id]) => !Object.hasOwn(defaults, id)));
  const workflows = { ...elsewhere, ...workflowOverrides({ ...activeChoices(context.profile, known), ...flags.workflows }, known) };
  for (const manifest of known) {
    for (const workflow of manifest.workflows ?? []) {
      if (!workflow.risk) continue;
      const wasOn = context.profile.packs.includes(manifest.name) && (context.profile.workflows[workflow.id] ?? workflow.default);
      const isOn = packs.includes(manifest.name) && (workflows[workflow.id] ?? workflow.default);
      if (isOn && (!wasOn || flags.workflows[workflow.id] === true)) context.print(`Before you use ${workflow.name}: ${workflow.risk}`);
    }
  }
  return saveAndApply(context, { packs, workflows, settings }, "your packs");
}

function listPacks(context: ChangeContext) {
  const on = new Set(activePacks(context).map((manifest) => manifest.name));
  const missing = context.plan.packs.filter((pack) => !pack.available);
  context.print("Your packs:");
  for (const manifest of manifests(context)) {
    const mark = manifest.name === "base" || on.has(manifest.name) ? "✓" : "·";
    context.print(`  ${mark} ${manifest.name}  ${manifest.summary}`);
    const workflows = context.plan.workflows.filter((workflow) => workflow.pack === manifest.name);
    if (on.has(manifest.name) && workflows.length) context.print(`      Workflows: ${workflows.map((workflow) => `${workflow.id} ${workflow.active ? "on" : "off"}`).join(", ")}`);
    if (on.has(manifest.name)) for (const workflow of manifest.workflows ?? []) if (workflow.risk) context.print(`      Terms note for ${workflow.id}: ${workflow.risk}`);
  }
  for (const pack of missing) context.print(`  ! ${pack.name}  is in your profile, but ${pack.reason ?? "its source is not here"}`);
  context.print("");
  context.print(`Change them with ${usage}.`);
}
