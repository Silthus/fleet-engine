import { rm } from "node:fs/promises";
import { join } from "node:path";
import { changedFiles, readOwned, requireInstalled, writeFiles, type Managed } from "./managed.ts";
import { gatewayPort, localGatewayUrl, readGatewayClient, saveGatewayClient, type Fetch, type GatewaySettings } from "../../mcp-gateway/lib/client.ts";
import type { Run } from "../../mcp-gateway/lib/hub.ts";
import { relayPortOf } from "./run.ts";

export type MacTunnelMode = "plan" | "install" | "doctor" | "remove";
export type MacTunnel = {
  /** gateway: the MCP gateway's settings while its workflow is on. Without it the Mac has nothing to forward. */
  home: string; platform: NodeJS.Platform; uid: number; alias: string; relayPort: number; gateway?: GatewaySettings; coder?: string;
  run: Run; fetch: Fetch; sleep(ms: number): Promise<void>; print(line: string): void;
};

export const tunnelLabel = "com.fleet.hub-tunnel";
const marker = "<!-- Managed by Fleet hub tunnel. -->";
const healthTries = 10;
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const string = (value: string) => `<string>${escape(value)}</string>`;

/** The Coder workspace behind a hub name: the bare workspace name, or the coder.<workspace> SSH name coder config-ssh writes. */
export function hubWorkspace(alias: string): string {
  const workspace = alias.replace(/^coder\./, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(workspace)) throw new Error(`hub.alias must be the hub's Coder workspace name or its coder.<workspace> SSH name, not ${JSON.stringify(alias)}.`);
  return workspace;
}

export function agentPlist(coder: string, alias: string, relayPort: number, log: string): string {
  const program = [coder, "port-forward", hubWorkspace(alias), "--tcp", `127.0.0.1:${gatewayPort}:${gatewayPort}`, "--tcp", `127.0.0.1:${relayPort}:${relayPort}`, "--disable-autostart"];
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

const notNeeded = "Hub tunnel: not needed. The MCP gateway is off, so this Mac forwards nothing to the hub.";

/** The MCP gateway is on when the profile has its pack and has not turned its workflow off. */
export function gatewayOn(profile: { packs?: unknown; workflows?: unknown }): boolean {
  const workflows = (profile.workflows ?? {}) as Record<string, unknown>;
  return Array.isArray(profile.packs) && profile.packs.includes("mcp-gateway") && workflows["mcp-gateway"] !== false;
}

export async function hubTunnel(mode: MacTunnelMode, mac: MacTunnel): Promise<number> {
  const { gateway } = mac;
  if (!gateway) return withoutGateway(mode, mac);
  if (mac.platform !== "darwin") throw new Error("Only a Mac opens its own hub tunnel. The hub opens the devbox tunnels with fleet ssh-tunnels.");
  if (mac.uid === 0) throw new Error("Run fleet hub-tunnel as the person who runs the agents, not root.");
  const agent = agentPath(mac);
  const domain = `gui/${mac.uid}`;
  const loaded = async () => (await mac.run(["launchctl", "print", `${domain}/${tunnelLabel}`])).code === 0;
  const forwards = `127.0.0.1:${gatewayPort} and 127.0.0.1:${relayPortOf(mac.relayPort)} to ${mac.alias}`;
  if (mode === "remove") return await removeAgent(mac), mac.print("Hub tunnel: removed. This Mac no longer forwards ports to the hub."), 0;
  if (mode === "plan") return mac.print(`Hub tunnel plan: write ${agent} and load it at login. It forwards ${forwards}.`), 0;
  if (mode === "install") await install(mac, gateway, agent, domain, loaded);
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
  hubWorkspace(mac.alias);
  if (!mac.coder) throw new Error("Install the Coder CLI first, then run coder login.");
  return { path: agent, content: agentPlist(mac.coder, mac.alias, mac.relayPort, join(mac.home, "Library/Logs/fleet-hub-tunnel.log")) };
}

const agentPath = (mac: Pick<MacTunnel, "home">) => join(mac.home, "Library/LaunchAgents", `${tunnelLabel}.plist`);

async function removeAgent(mac: MacTunnel) {
  const agent = agentPath(mac);
  await readOwned(mac.home, agent, marker, "hub tunnel");
  const target = `gui/${mac.uid}/${tunnelLabel}`;
  if ((await mac.run(["launchctl", "print", target])).code === 0) await mac.run(["launchctl", "bootout", target]);
  await rm(agent, { force: true });
}

/** Without the gateway, install and remove take away an agent Fleet wrote earlier, and plan and the doctor have nothing to check. */
async function withoutGateway(mode: MacTunnelMode, mac: MacTunnel) {
  if ((mode === "install" || mode === "remove") && (await readOwned(mac.home, agentPath(mac), marker, "hub tunnel")) !== undefined) await removeAgent(mac);
  return mac.print(notNeeded), 0;
}

async function install(mac: MacTunnel, gateway: GatewaySettings, agent: string, domain: string, loaded: () => Promise<boolean>) {
  const changed = await changedFiles(mac.home, [wantedAgent(mac, agent)], marker, "hub tunnel");
  if (changed.length) {
    if (await loaded()) await mac.run(["launchctl", "bootout", `${domain}/${tunnelLabel}`]);
    await writeFiles(changed);
    mac.print("Hub tunnel: launch agent written. Stop any port-forward you started by hand, so the agent can use the ports.");
  }
  if (!(await loaded()) && (await mac.run(["launchctl", "bootstrap", domain, agent])).code !== 0) throw new Error("launchd did not load the hub tunnel.");
  const client = await readGatewayClient(mac.home, gateway);
  if (client && client.baseUrl !== localGatewayUrl) {
    await saveGatewayClient(mac.home, { ...client, baseUrl: localGatewayUrl }, gateway);
    mac.print(`Hub tunnel: MCP clients use ${localGatewayUrl}.`);
  }
}

async function answers(mac: MacTunnel) {
  const response = await mac.fetch(`http://127.0.0.1:${gatewayPort}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  return response?.ok === true;
}
