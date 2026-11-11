import type { MachineFile, Plan } from "../pack/types.ts";
import { isKeptForBoxes, isNodeName } from "../hub/names.ts";
import { onHub } from "../hub/ssh.ts";
import { loadProfile, pullProfile, saveAnswers, saveMachine, validHost } from "../profile/profile.ts";
import type { Machine } from "../setup/commands.ts";
import { devboxSteps, nameBox, overSsh, profileForBox } from "../setup/devbox.ts";
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
  refuseUnusableName(host);
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

function refuseUnusableName(host: string) {
  if (!isNodeName(host)) throw new FlagError(`${host} is not a name the hub can use. Give the devbox an SSH name in ~/.ssh/config of lowercase letters, digits, dots and dashes, starting with a letter or a digit.`);
  if (isKeptForBoxes(host)) throw new FlagError(`${host} is a pool box name. Names that start with box- are kept for the boxes the hub starts; give the devbox another SSH name.`);
}

const hubUpdateLimitMs = 15 * 60_000;
const hubLinkLimitMs = 5 * 60_000;
const sshFailed = 255;

/** Lists the devbox in the profile, so the hub and every node know it, and returns the hub the profile names. It pushes on every run, so a push that failed before reaches the remote now. */
async function listInProfile(profileDir: string | undefined, host: string): Promise<string | undefined> {
  if (!profileDir) return undefined;
  await pullProfile(profileDir);
  const profile = await loadProfile(profileDir);
  const devboxes = profile.devboxes?.includes(host) ? profile.devboxes : [...(profile.devboxes ?? []), host];
  await saveAnswers(profileDir, { devboxes }, { push: true });
  return profile.hub;
}

/** Has the hub take the new node before the node applies its profile, so the hub serves the node's credentials, and its disk watch and tunnels include it. */
async function tellHub({ machine, terminal }: DevboxCommandContext, hub: string, host: string): Promise<boolean> {
  terminal.print(`▶ The hub, ${hub}, takes ${host} with fleet update there. This can take some minutes.`);
  const updated = await machine.exec(onHub(hub, ["update"]), { timeoutMs: hubUpdateLimitMs });
  const reason = updated.output.trim().split("\n").at(-1);
  if (updated.code === 0) terminal.print(`✓ The hub, ${hub}, took ${host}: its disk watch, tunnels and credentials include it now.`);
  else if (updated.code === sshFailed || !reason) terminal.print(`· The hub, ${hub}, did not answer. It takes ${host} at its next fleet update, or run fleet update there now.`);
  else terminal.print(`· The hub, ${hub}, could not update: ${reason} Fix that there and run fleet update there; it takes ${host} then.`);
  return updated.code === 0;
}

async function linkFromHub({ machine, terminal }: DevboxCommandContext, hub: string, host: string, hubTook: boolean) {
  const linked = hubTook && (await machine.exec(onHub(hub, ["peers", "link", host]), { timeoutMs: hubLinkLimitMs })).code === 0;
  terminal.print(linked ? `✓ The hub, ${hub}, linked ${host} in T3 Code.` : `· The hub, ${hub}, has not linked ${host} in T3 Code yet. Its daily fleet peers renew links it, or run fleet peers link ${host} there now.`);
}
