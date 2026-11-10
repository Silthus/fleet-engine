import { saveMachine, validHost } from "../profile/profile.ts";
import { FlagError } from "../setup/flags.ts";
import { type ChangeContext, saveAndApply } from "./change.ts";

const usage = "usage: fleet hub here [<ssh name>], or fleet hub status";

/** Names this machine the hub in the profile, or shows this machine's name and the hub. */
export async function hubCommand(args: string[], context: ChangeContext & { home: string }): Promise<number> {
  const { machine } = context.plan;
  const [action, name = machine.name, ...rest] = args;
  if (action === "status" && args.length === 1) {
    context.print(`This machine: ${machine.name ?? "not named"}, ${machine.role === "hub" ? "the hub" : `a ${machine.role}`}.`);
    context.print(context.profile.hub ? `The hub: ${context.profile.hub}.` : "The hub: not named. Run fleet hub here on the machine that should be the hub.");
    return 0;
  }
  if (action !== "here" || !name || rest.length || !validHost(name)) throw new FlagError(usage);
  await saveMachine(context.home, { ...machine, name, role: "hub" });
  return saveAndApply(context, { hub: name }, `the hub, ${name},`);
}
