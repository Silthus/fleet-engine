import type { CatalogEntry, Owned, PackJob } from "../pack/types.ts";
import { validHost } from "../profile/profile.ts";

export const forwardId = "hub-forward";

const batch = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", "-o", "ForwardAgent=no"];
const keepAlive = ["-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"];
const launcher = 'PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" sh "$HOME/.local/share/fleet/engine/fleet"';
const local = (port: number) => ["-L", `127.0.0.1:${port}:127.0.0.1:${port}`];

/** The service on a node that dials the hub and carries every catalog port to the same port at loopback. */
export function hubForward(hub: string, catalog: CatalogEntry[]): Owned<PackJob> {
  const ports = catalog.map((entry) => entry.port).sort((a, b) => a - b);
  return { id: forwardId, pack: "engine", schedule: { every: "always" }, command: ["ssh", "-NT", ...batch, ...keepAlive, ...ports.flatMap(local), hub] };
}

export function quote(word: string) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The one ssh call from a node to the hub: batch mode, a checked host name, each word quoted, and Fleet's launcher at its install path, not the login PATH. */
export function onHub(hub: string, args: string[]): string[] {
  if (!validHost(hub)) throw new Error(`${hub} is not an SSH host name`);
  return ["ssh", "-T", ...batch, hub, [launcher, ...args.map(quote)].join(" ")];
}
