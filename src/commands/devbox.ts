import type { MachineFile, Plan } from "../pack/types.ts";
import { saveMachine, validHost } from "../profile/profile.ts";
import type { Machine } from "../setup/commands.ts";
import { devboxSteps, linkFromHub, listInProfile, nameBox, overSsh, profileForBox, tellHub } from "../setup/devbox.ts";
import { FlagError, refuseUnusableDevbox } from "../setup/flags.ts";
import { runSteps } from "../setup/runner.ts";
import { Stopped, type Terminal } from "../setup/terminal.ts";

export type DevboxCommandContext = { home: string; terminal: Terminal; machine: Machine; machineFile: MachineFile; plan: Plan };

const usage = "usage: fleet devbox, or fleet devbox add <ssh host>";

/** Lists the devboxes, or makes an SSH host a devbox with the same steps setup runs. */
export async function devboxCommand(args: string[], context: DevboxCommandContext): Promise<number> {
  const { terminal, machineFile } = context;
  if (!args.length) {
    const hosts = machineFile.devboxes ?? [];
    terminal.print(hosts.length ? `Your devboxes: ${hosts.join(", ")}` : "No devbox yet.");
    terminal.print("Add one with fleet devbox add <ssh host>.");
    return 0;
  }
  const [action, host, ...rest] = args;
  if (action !== "add" || !host || rest.length || !validHost(host)) throw new FlagError(usage);
  refuseUnusableDevbox(host);
  await nameBox(overSsh(context.machine, host), host);
  const remember = () => saveMachine(context.home, machineFile);
  if (!machineFile.devboxes?.includes(host)) {
    machineFile.devboxes = [...(machineFile.devboxes ?? []), host];
    await remember();
  }
  const listedHub = await listInProfile(machineFile.profileDir, host);
  const hub = listedHub && listedHub !== host ? listedHub : undefined;
  const hubTook = hub !== undefined && (await tellHub(context, hub, host));
  const steps = () => devboxSteps(host, { terminal, machine: context.machine, nonInteractive: false, plan: context.plan.ai, models: context.plan.models, profile: () => profileForBox(context.machine, machineFile.profileDir) });
  try {
    await runSteps(steps, {
      terminal,
      done: (machineFile.setup?.done ?? []).filter((id) => id !== `devbox:${host}:coder`),
      async save(done) {
        machineFile.setup = { ...machineFile.setup, done };
        await remember();
      },
    });
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    terminal.print("");
    terminal.print(`Stopped. Run fleet devbox add ${host} again to pick up where it stopped.`);
    return 130;
  }
  terminal.print("");
  terminal.print(`${host} is your devbox now. It runs your profile, and T3 Code here and there can reach each other.`);
  if (hub) await linkFromHub(context, hub, host, hubTook);
  return 0;
}
