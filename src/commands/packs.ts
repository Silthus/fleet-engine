import { activeChoices, workflowDefaults, workflowOverrides } from "../profile/profile.ts";
import { FlagError, parseSetupFlags } from "../setup/flags.ts";
import { activePacks, type ChangeContext, manifests, saveAndApply } from "./change.ts";

const usage = "fleet packs [--add <pack>]... [--remove <pack>]... [--workflows <id=on|off,...>]";

/** Lists the packs, or turns packs and workflows on and off. */
export async function packsCommand(args: string[], context: ChangeContext): Promise<number> {
  const flags = parseSetupFlags(args);
  if (flags.preset !== undefined || flags.plan !== undefined || flags.devbox !== undefined || flags.nonInteractive || Object.keys(flags.set).length) throw new FlagError(`usage: ${usage}`);
  if (!flags.add.length && !flags.remove.length && !Object.keys(flags.workflows).length) return listPacks(context), 0;

  const known = manifests(context);
  const names = new Set(known.filter((manifest) => manifest.name !== "base").map((manifest) => manifest.name));
  for (const name of [...flags.add, ...flags.remove]) {
    if (name === "base") throw new FlagError("the base pack is always on");
    if (!names.has(name)) throw new FlagError(`no pack named ${name}. Packs: ${[...names].join(", ")}`);
  }
  const defaults = workflowDefaults(known);
  for (const id of Object.keys(flags.workflows)) if (!(id in defaults)) throw new FlagError(`--workflows: no workflow named ${id}`);

  const packs = [...new Set([...context.profile.packs, ...flags.add])].filter((name) => !flags.remove.includes(name));
  const workflows = workflowOverrides({ ...activeChoices(context.profile, known), ...flags.workflows }, known);
  return saveAndApply(context, { packs, workflows }, "your packs");
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
  }
  for (const pack of missing) context.print(`  ! ${pack.name}  is in your profile, but ${pack.reason ?? "its source is not here"}`);
  context.print("");
  context.print(`Change them with ${usage}.`);
}
