import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MachineFile } from "../pack/types.ts";
import { loadProfile } from "../profile/profile.ts";
import type { Machine } from "./commands.ts";
import { overSsh, t3HomeGuard } from "./devbox.ts";
import type { Terminal } from "./terminal.ts";

export type BalanceContext = { home: string; terminal: Terminal; machine: Machine; machineFile: MachineFile };

const normal = 50;
const manualOnly = 0;
const environmentId = /^[A-Za-z0-9._:-]{1,128}$/;
const manualSteps = "In T3 Code, open Settings → Environments → Load balancing, turn it on, and set this Mac and the hub to Manual only.";

/** T3 Code on the Mac starts new threads on the nodes: the hub, and the Mac itself until someone sets it, go to Manual only. A weight already set stays, so a node someone drains keeps draining. */
export async function balanceThreads(context: BalanceContext) {
  const { terminal, machineFile } = context;
  if (machineFile.role !== "mac" || !machineFile.profileDir) return;
  const { hub, devboxes = [] } = await loadProfile(machineFile.profileDir);
  const nodes = devboxes.filter((host) => host !== hub);
  if (!nodes.length) return terminal.print("· New threads stay on this Mac until a node runs. Add one with fleet devbox add <ssh host>.");
  const userdata = join(context.home, ".t3", "userdata");
  const path = join(userdata, "client-settings.json");
  if (!existsSync(userdata)) return terminal.print(`· T3 Code has not run on this Mac yet. Once it has, ${manualSteps}`);
  const settings = await readSettings(path);
  if (!settings) return terminal.print(`· Fleet cannot read ${path}, so it left it alone. ${manualSteps}`);
  const weights: Record<string, number> = { ...(settings.loadBalancingWeights as Record<string, number> | undefined) };
  const ids = new Map<string, string>();
  const here = idOf(await readFile(join(userdata, "environment-id"), "utf8").catch(() => ""));
  for (const host of new Set([...devboxes, ...(hub ? [hub] : [])])) {
    const id = await boxEnvironmentId(context.machine, host);
    if (id) ids.set(host, id);
  }
  if (here) weights[here] ??= manualOnly;
  for (const host of nodes) {
    const id = ids.get(host);
    if (id) weights[id] ??= normal;
  }
  const hubId = hub && ids.get(hub);
  if (hubId) weights[hubId] = manualOnly;
  await writeSettings(path, { ...settings, loadBalancingEnabled: true, loadBalancingWeights: weights });
  const share = (id: string | undefined) => (id === undefined ? normal : (weights[id] ?? normal)) > 0;
  const taking = [...nodes.filter((host) => share(ids.get(host))), ...(here && share(here) ? ["this Mac"] : [])];
  terminal.print(taking.length ? `✓ T3 Code on this Mac starts new threads on ${taking.join(" and ")}. Quit and reopen T3 Code so it reads this.` : `· Every node is set to Manual only in T3 Code on this Mac, so new threads start where you choose. ${manualSteps}`);
}

/** The id T3 Code on that host goes by, the key of its load balancing weight and of its link here. */
export async function boxEnvironmentId(machine: Machine, host: string) {
  return idOf((await overSsh(machine, host).exec(["sh", "-c", environmentIdScript])).stdout);
}

/** Drops a machine that left from T3 Code's load balancing on this Mac. */
export async function forgetWeight(home: string, id: string) {
  const path = join(home, ".t3", "userdata", "client-settings.json");
  if (!existsSync(path)) return;
  const settings = await readSettings(path);
  const weights = settings?.loadBalancingWeights as Record<string, number> | undefined;
  if (!weights || !(id in weights)) return;
  const { [id]: _, ...kept } = weights;
  await writeSettings(path, { ...settings, loadBalancingWeights: kept });
}

const environmentIdScript = `${t3HomeGuard} cat "\${T3CODE_HOME:-$HOME/.t3}/userdata/environment-id"`;

function idOf(text: string) {
  const id = text.trim();
  return environmentId.test(id) ? id : undefined;
}

async function readSettings(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const weights = (parsed as Record<string, unknown>).loadBalancingWeights;
    if (weights !== undefined && (typeof weights !== "object" || weights === null || Array.isArray(weights))) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function writeSettings(path: string, settings: Record<string, unknown>) {
  const temporary = `${path}.fleet-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(temporary, path);
}
