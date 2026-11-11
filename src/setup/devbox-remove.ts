import type { MachineFile } from "../pack/types.ts";
import { loadProfile, pullProfile, saveAnswers, saveMachine } from "../profile/profile.ts";
import type { Machine } from "./commands.ts";
import { boxEnvironmentId, forgetWeight } from "./devbox-balance.ts";
import type { Terminal } from "./terminal.ts";

export type RemoveContext = { home: string; terminal: Terminal; machine: Machine; machineFile: MachineFile };

type Link = { environmentId: string; label?: string };

/** Takes a replaced hub or node out of the profile and this machine's list, unlinks it in T3 Code here, and drops its load balancing weight. The hub stops its tunnel, disk watch and link at its next fleet update. */
export async function removeDevbox(host: string, context: RemoveContext) {
  const { terminal, machineFile } = context;
  const profileDir = machineFile.profileDir;
  if (profileDir) await pullProfile(profileDir);
  const profile = profileDir ? await loadProfile(profileDir) : undefined;
  if (profile?.hub === host) throw new Error(`${host} is your hub. Run fleet hub here on the new hub first, then fleet devbox remove ${host}.`);
  const listed = [...(profile?.devboxes ?? []), ...(machineFile.devboxes ?? [])].includes(host);
  if (!listed) throw new Error(`${host} is not one of your devboxes. fleet devbox lists them.`);
  const id = (await boxEnvironmentId(context.machine, host)) ?? (await linkByLabel(context.machine, host))?.environmentId;
  if (profileDir && profile?.devboxes?.includes(host)) await saveAnswers(profileDir, { devboxes: profile.devboxes.filter((name) => name !== host) }, { push: true });
  if (machineFile.devboxes?.includes(host)) {
    machineFile.devboxes = machineFile.devboxes.filter((name) => name !== host);
    await saveMachine(context.home, machineFile);
  }
  const unlinked = id !== undefined && (await linksHere(context.machine)).some((link) => link.environmentId === id) && (await context.machine.exec(["t3", "environment", "unlink", id])).code === 0;
  if (id) await forgetWeight(context.home, id);
  const hubStops = "The hub stops its tunnel, disk watch and link to it at its next fleet update.";
  if (unlinked) return terminal.print(`✓ Removed ${host} from your profile and unlinked it in T3 Code here. ${hubStops}`);
  terminal.print(`✓ Removed ${host} from your profile. ${hubStops}`);
  terminal.print(`· T3 Code here has no link to ${host} that Fleet can find. When T3 Code still lists it, remove it in Settings → Environments.`);
}

async function linksHere(machine: Machine): Promise<Link[]> {
  const listed = await machine.exec(["t3", "environment", "list", "--json"]);
  if (listed.code !== 0) return [];
  try {
    const links: unknown = JSON.parse(listed.stdout);
    return Array.isArray(links) ? links.filter((link): link is Link => typeof link?.environmentId === "string") : [];
  } catch {
    return [];
  }
}

/** A workspace that is gone cannot say its id, so the one link here labelled with its name stands in, as T3 labels a machine by its host name. */
async function linkByLabel(machine: Machine, host: string) {
  const names = new Set([host, host.replace(/^coder\./, "")]);
  const matching = (await linksHere(machine)).filter((link) => link.label !== undefined && names.has(link.label));
  return matching.length === 1 ? matching[0] : undefined;
}
