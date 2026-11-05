import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { changedFiles, writeFiles } from "./managed.ts";
import { peersOf, readRole } from "./machine.ts";
import type { Run } from "./mcphub/hub.ts";
import { gatewayPort, hostPattern, must, relayPortOf, sshName } from "./run.ts";

export type TunnelMode = "plan" | "install" | "doctor";
export type TunnelMachine = { home: string; devboxes: string[]; relayPort: number; httpsHost?: string; hosts: string; run: Run; print(line: string): void };

const marker = "# Managed by Fleet hub SSH tunnels.";
const hostsMarker = " # fleet-hub-tunnel";
const unitName = (alias: string) => `fleet-ssh-${alias}.service`;
const loopback = (port: number) => `-R 127.0.0.1:${port}:127.0.0.1:${port}`;

export function tunnelTargets(hub: string, devboxes: string[], self: string): string[] {
  return peersOf(hub, devboxes, self).filter((alias) => alias !== hub);
}

export function tunnelUnit(alias: string, relayPort: number): string {
  return `${marker}
[Unit]
Description=Fleet hub SSH tunnel for ${sshName(alias)}

[Service]
Environment=CODER_SSH_DISABLE_AUTOSTART=true
ExecStart=/usr/bin/ssh -NT -o BatchMode=yes -o ConnectTimeout=30 -o ExitOnForwardFailure=yes -o ForwardAgent=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 ${loopback(gatewayPort)} ${loopback(relayPortOf(relayPort))} ${alias}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function hostsWith(previous: string, host: string): string {
  const lines = previous.split("\n").filter((line) => !line.endsWith(hostsMarker));
  while (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.split("#", 1)[0]!.trim().split(/\s+/).slice(1).includes(host))) throw new Error(`Keep unmanaged hosts entry for ${host}.`);
  return [...lines, `127.0.0.1 ${host}${hostsMarker}`, ""].join("\n");
}

export async function sshTunnels(mode: TunnelMode, machine: TunnelMachine): Promise<number> {
  const role = readRole(machine.home);
  if (role === "hub") return hubTunnels(mode, machine);
  if (role === "devbox") return devboxHosts(mode, machine);
  throw new Error(`fleet ssh-tunnels runs on the hub or a devbox, not on a ${role ?? "machine without a role"}. On a Mac, run fleet hub-tunnel.`);
}

async function hubTunnels(mode: TunnelMode, machine: TunnelMachine) {
  const directory = join(machine.home, ".config/systemd/user");
  const units = machine.devboxes.map((alias) => ({ alias, name: unitName(alias), path: join(directory, unitName(alias)), content: tunnelUnit(alias, machine.relayPort) }));
  const changed = await changedFiles(machine.home, units, marker, "tunnel");
  const systemctl = (...args: string[]) => must(machine.run, ["systemctl", "--user", ...args]);
  if (mode === "install") {
    await writeFiles(changed);
    await systemctl("daemon-reload");
    for (const unit of units) {
      if (changed.includes(unit)) await systemctl("restart", unit.name);
      await systemctl("enable", "--now", unit.name);
    }
  }
  for (const unit of units) {
    if (mode !== "plan") {
      await systemctl("is-enabled", "--quiet", unit.name);
      await systemctl("is-active", "--quiet", unit.name);
    }
    machine.print(`${unit.alias}: SSH tunnel ${mode === "plan" ? "planned" : "active"}`);
  }
  return 0;
}

async function devboxHosts(mode: TunnelMode, machine: TunnelMachine) {
  const host = machine.httpsHost;
  if (!host) return machine.print("No hosts entry needed: hub.httpsHost is empty."), 0;
  if (!hostPattern.test(host)) throw new Error(`hub.httpsHost is not a host name: ${JSON.stringify(host)}`);
  if ((await lstat(machine.hosts)).isSymbolicLink()) throw new Error(`Keep linked hosts file: ${machine.hosts}`);
  const previous = await readFile(machine.hosts, "utf8");
  const wanted = hostsWith(previous, host);
  if (mode === "doctor" && previous !== wanted) throw new Error(`${machine.hosts} does not map ${host} to the hub tunnel. Run fleet ssh-tunnels install.`);
  if (mode === "install" && previous !== wanted) await must(machine.run, ["sudo", "-n", "tee", machine.hosts], wanted);
  machine.print(`${host}: hosts entry ${mode === "plan" ? "planned" : "present"}`);
  return 0;
}
