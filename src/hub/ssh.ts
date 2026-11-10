import type { CatalogEntry, Owned, PackJob } from "../pack/types.ts";

export const forwardId = "hub-forward";

const batch = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", "-o", "ForwardAgent=no"];
const keepAlive = ["-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"];
const local = (port: number) => ["-L", `127.0.0.1:${port}:127.0.0.1:${port}`];

/** The service on a node that dials the hub and carries every catalog port to the same port at loopback. */
export function hubForward(hub: string, catalog: CatalogEntry[]): Owned<PackJob> {
  const ports = catalog.map((entry) => entry.port).sort((a, b) => a - b);
  return { id: forwardId, pack: "engine", schedule: { every: "always" }, command: ["ssh", "-NT", ...batch, ...keepAlive, ...ports.flatMap(local), hub] };
}
