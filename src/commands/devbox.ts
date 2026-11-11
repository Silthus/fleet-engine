import type { MachineFile, Plan } from "../pack/types.ts";
import { onHub } from "../hub/ssh.ts";
import { loadProfile, pullProfile, saveAnswers, saveMachine, validHost } from "../profile/profile.ts";
import type { Machine } from "../setup/commands.ts";
import { devboxSteps, profileForBox } from "../setup/devbox.ts";
import { FlagError } from "../setup/flags.ts";
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
  const remember = () => saveMachine(context.home, machineFile);
  if (!machineFile.devboxes?.includes(host)) {
    machineFile.devboxes = [...(machineFile.devboxes ?? []), host];
    await remember();
  }
  const hub = await listInProfile(machineFile.profileDir, host);
  const steps = () => devboxSteps(host, { terminal, machine: context.machine, nonInteractive: false, plan: context.plan.ai, models: context.plan.models, profile: () => profileForBox(context.machine, machineFile.profileDir) });
  try {
    await runSteps(steps, {
      terminal,
      done: machineFile.setup?.done ?? [],
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
  if (hub && hub !== host) await tellHub(context, hub, host);
  return 0;
}

const hubUpdateLimitMs = 15 * 60_000;

/** Lists the devbox in the profile, so the hub and every node know it, and returns the hub the profile names. */
async function listInProfile(profileDir: string | undefined, host: string): Promise<string | undefined> {
  if (!profileDir) return undefined;
  await pullProfile(profileDir);
  const profile = await loadProfile(profileDir);
  if (!profile.devboxes?.includes(host)) await saveAnswers(profileDir, { devboxes: [...(profile.devboxes ?? []), host] }, { push: true });
  return profile.hub;
}

/** Has the hub take the new node now, so its disk watch, tunnels and peer links include it before the next nightly update. */
async function tellHub({ machine, terminal }: DevboxCommandContext, hub: string, host: string) {
  const updated = await machine.exec(onHub(hub, ["update"]), { timeoutMs: hubUpdateLimitMs });
  terminal.print(updated.code === 0 ? `✓ The hub, ${hub}, took ${host}: its disk watch, tunnels and peer links include it now.` : `· The hub, ${hub}, did not answer. It takes ${host} at its next fleet update, or run fleet update there now.`);
}
