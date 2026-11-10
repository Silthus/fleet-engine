import { rm } from "node:fs/promises";
import { join } from "node:path";
import { changedFiles, readOwned, requireInstalled, writeFiles, type Managed } from "./managed.ts";
import { gatewayPort, localGatewayUrl, readGatewayClient, saveGatewayClient, type Fetch, type GatewaySettings } from "../../mcp-gateway/lib/client.ts";
import type { Run } from "../../mcp-gateway/lib/hub.ts";
import { relayPortOf } from "./run.ts";

export type MacTunnelMode = "plan" | "install" | "doctor" | "remove";
export type MacTunnel = {
  home: string; platform: NodeJS.Platform; uid: number; alias: string; relayPort: number; gateway: GatewaySettings; coder?: string;
  run: Run; fetch: Fetch; sleep(ms: number): Promise<void>; print(line: string): void;
};

export const tunnelLabel = "com.fleet.hub-tunnel";
const marker = "<!-- Managed by Fleet hub tunnel. -->";
const healthTries = 10;
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const string = (value: string) => `<string>${escape(value)}</string>`;

export function agentPlist(coder: string, alias: string, relayPort: number, log: string): string {
  const program = [coder, "port-forward", alias, "--tcp", `127.0.0.1:${gatewayPort}:${gatewayPort}`, "--tcp", `127.0.0.1:${relayPort}:${relayPort}`, "--disable-autostart"];
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    marker,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  ${string(tunnelLabel)}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...program.map((arg) => `    ${string(arg)}`),
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>10</integer>`,
    `  <key>StandardOutPath</key>`,
    `  ${string(log)}`,
    `  <key>StandardErrorPath</key>`,
    `  ${string(log)}`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export async function hubTunnel(mode: MacTunnelMode, mac: MacTunnel): Promise<number> {
  if (mac.platform !== "darwin") throw new Error("Only a Mac opens its own hub tunnel. The hub opens the devbox tunnels with fleet ssh-tunnels.");
  if (mac.uid === 0) throw new Error("Run fleet hub-tunnel as the person who runs the agents, not root.");
  const agent = join(mac.home, "Library/LaunchAgents", `${tunnelLabel}.plist`);
  const domain = `gui/${mac.uid}`;
  const loaded = async () => (await mac.run(["launchctl", "print", `${domain}/${tunnelLabel}`])).code === 0;
  const forwards = `127.0.0.1:${gatewayPort} and 127.0.0.1:${relayPortOf(mac.relayPort)} to ${mac.alias}`;
  if (mode === "remove") {
    await readOwned(mac.home, agent, marker, "hub tunnel");
    if (await loaded()) await mac.run(["launchctl", "bootout", `${domain}/${tunnelLabel}`]);
    await rm(agent, { force: true });
    return mac.print("Hub tunnel: removed. This Mac no longer forwards ports to the hub."), 0;
  }
  if (mode === "plan") return mac.print(`Hub tunnel plan: write ${agent} and load it at login. It forwards ${forwards}.`), 0;
  if (mode === "install") await install(mac, agent, domain, loaded);
  else await requireInstalled(mac.home, [wantedAgent(mac, agent)], marker, "hub tunnel", "fleet hub-tunnel install");
  if (!(await loaded())) throw new Error("The launch agent is not loaded. Run fleet hub-tunnel install.");
  for (let attempt = 1; !(await answers(mac)); attempt++) {
    if (attempt === healthTries) throw new Error(`127.0.0.1:${gatewayPort} does not reach the MCP gateway on ${mac.alias}. Check ~/Library/Logs/fleet-hub-tunnel.log, and run coder login if the session expired.`);
    await mac.sleep(1000);
  }
  mac.print(`Hub tunnel: forwards ${forwards} from login.`);
  return 0;
}

function wantedAgent(mac: MacTunnel, agent: string): Managed {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(mac.alias)) throw new Error(`hub.alias must be the hub's Coder workspace name, not ${JSON.stringify(mac.alias)}.`);
  if (!mac.coder) throw new Error("Install the Coder CLI first, then run coder login.");
  return { path: agent, content: agentPlist(mac.coder, mac.alias, mac.relayPort, join(mac.home, "Library/Logs/fleet-hub-tunnel.log")) };
}

async function install(mac: MacTunnel, agent: string, domain: string, loaded: () => Promise<boolean>) {
  const changed = await changedFiles(mac.home, [wantedAgent(mac, agent)], marker, "hub tunnel");
  if (changed.length) {
    if (await loaded()) await mac.run(["launchctl", "bootout", `${domain}/${tunnelLabel}`]);
    await writeFiles(changed);
    mac.print("Hub tunnel: launch agent written. Stop any port-forward you started by hand, so the agent can use the ports.");
  }
  if (!(await loaded()) && (await mac.run(["launchctl", "bootstrap", domain, agent])).code !== 0) throw new Error("launchd did not load the hub tunnel.");
  const client = await readGatewayClient(mac.home, mac.gateway);
  if (client && client.baseUrl !== localGatewayUrl) {
    await saveGatewayClient(mac.home, { ...client, baseUrl: localGatewayUrl }, mac.gateway);
    mac.print(`Hub tunnel: MCP clients use ${localGatewayUrl}.`);
  }
}

async function answers(mac: MacTunnel) {
  const response = await mac.fetch(`http://127.0.0.1:${gatewayPort}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  return response?.ok === true;
}
