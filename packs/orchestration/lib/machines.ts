import { listLinkedEnvironments, type LinkedEnvironment, type T3Client } from "../../base/lib/t3/index.ts";

export type Machine = { host: string; environment?: LinkedEnvironment };
export type MachineReport<R> = (R & { host: string; error?: undefined }) | { host: string; error: string };

export const liveStatuses = ["preparing", "queued", "starting", "running", "waiting"];

export async function readMachines(client: Pick<T3Client, "call">, host: string): Promise<Machine[]> {
  const links = await listLinkedEnvironments(client);
  return [{ host }, ...links.map((environment) => ({ host: environment.label, environment }))];
}

export function pickMachine(machines: Machine[], host: string): Machine {
  const found = machines.find((machine) => machine.host === host || machine.environment?.environmentId === host);
  if (found) return found;
  const linked = machines.flatMap((machine) => (machine.environment ? [machine.host] : []));
  throw new Error(`No linked environment ${host}. Linked: ${linked.join(", ") || "none"}.`);
}

export function readEachMachine<R>(
  machines: Machine[], local: () => Promise<R>, linked: (environmentId: string) => Promise<R>,
): Promise<MachineReport<R>[]> {
  return Promise.all(machines.map(async ({ host, environment }): Promise<MachineReport<R>> => {
    if (!environment) return { ...(await local()), host };
    const problem = linkProblem(environment);
    if (problem) return { host, error: problem };
    try {
      return { ...(await linked(environment.environmentId)), host };
    } catch (error) { return { host, error: (error as Error).message }; }
  }));
}

function linkProblem(environment: LinkedEnvironment): string | undefined {
  if (environment.status === "expired") return "its link expired. Link it again in T3 Code's Settings → Connections.";
  if (environment.status === "unreachable") return `did not answer: ${environment.lastError ?? "T3 marks its link unreachable"}`;
  return undefined;
}
