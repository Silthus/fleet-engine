import { rm } from "node:fs/promises";
import { join } from "node:path";
import { changedFiles, readOwned, requireInstalled, writeFiles, type Managed } from "./managed.ts";
import { gatewayPort, localGatewayUrl, readGatewayClient, saveGatewayClient, type Fetch } from "../../mcp-gateway/lib/client.ts";
import type { Run } from "../../mcp-gateway/lib/hub.ts";
import { relayPortOf } from "./run.ts";

export type MacTunnelMode = "plan" | "install" | "doctor" | "remove" | "left";
export type MacTunnel = {
  /** gateway: the MCP gateway's workflow is on. httpsHost: hub HTTPS is on, and the browser reaches it through the relay port. */
  home: string; platform: NodeJS.Platform; uid: number; alias: string; relayPort: number; gateway: boolean; httpsHost?: string; coder?: string;
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

export function agentPlist(coder: string, alias: string, ports: number[], log: string): string {
  const program = [coder, "port-forward", hubWorkspace(alias), ...ports.flatMap((port) => ["--tcp", `127.0.0.1:${port}:${port}`]), "--disable-autostart"];
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

const nothingToForward = "The MCP gateway is off and hub.httpsHost is empty, so this Mac forwards nothing to the hub.";

/** The MCP gateway is on when the profile has its pack, or the Hub pack that carries it, and has not turned its workflow off. */
export function gatewayOn(profile: { packs?: unknown; workflows?: unknown }): boolean {
  const workflows = (profile.workflows ?? {}) as Record<string, unknown>;
  const packs = Array.isArray(profile.packs) ? profile.packs : [];
  return (packs.includes("mcp-gateway") || packs.includes("hub")) && workflows["mcp-gateway"] !== false;
}

/** The hub ports this Mac forwards: the MCP gateway's while it is on, and the relay while hub HTTPS sends the browser through it. */
function forwardedPorts(mac: MacTunnel): number[] {
  return [...(mac.gateway ? [gatewayPort] : []), ...(mac.httpsHost ? [relayPortOf(mac.relayPort)] : [])];
}

export async function hubTunnel(mode: MacTunnelMode, mac: MacTunnel): Promise<number> {
  if (mode === "left") return (await readOwned(mac.home, agentPath(mac), marker, "hub tunnel")) !== undefined || (mac.platform === "darwin" && (await agentLoaded(mac))) ? 0 : 1;
  const ports = forwardedPorts(mac);
  if (!ports.length) return withoutTunnel(mode, mac);
  if (mac.platform !== "darwin") throw new Error("Only a Mac opens its own hub tunnel. The hub opens the devbox tunnels with fleet ssh-tunnels.");
  if (mac.uid === 0) throw new Error("Run fleet hub-tunnel as the person who runs the agents, not root.");
  const agent = agentPath(mac);
  const domain = `gui/${mac.uid}`;
  const loaded = () => agentLoaded(mac);
  const forwards = `${ports.map((port) => `127.0.0.1:${port}`).join(" and ")} to ${mac.alias}`;
  if (mode === "remove") return await removeAgent(mac), mac.print("Hub tunnel: removed. This Mac no longer forwards ports to the hub."), 0;
  if (mode === "plan") return mac.print(`Hub tunnel plan: write ${agent} and load it at login. It forwards ${forwards}.`), 0;
  if (mode === "install") await install(mac, ports, agent, domain, loaded);
  else await requireInstalled(mac.home, [wantedAgent(mac, ports, agent)], marker, "hub tunnel", "fleet hub-tunnel install");
  if (!(await loaded())) throw new Error("The launch agent is not loaded. Run fleet hub-tunnel install.");
  for (let attempt = 1; mac.gateway && !(await answers(mac)); attempt++) {
    if (attempt === healthTries) throw new Error(`127.0.0.1:${gatewayPort} does not reach the MCP gateway on ${mac.alias}. Check ~/Library/Logs/fleet-hub-tunnel.log, and run coder login if the session expired.`);
    await mac.sleep(1000);
  }
  mac.print(`Hub tunnel: forwards ${forwards} from login.`);
  return 0;
}

function wantedAgent(mac: MacTunnel, ports: number[], agent: string): Managed {
  hubWorkspace(mac.alias);
  if (!mac.coder) throw new Error("Install the Coder CLI first, then run coder login.");
  return { path: agent, content: agentPlist(mac.coder, mac.alias, ports, join(mac.home, "Library/Logs/fleet-hub-tunnel.log")) };
}

const agentTarget = (mac: MacTunnel) => `gui/${mac.uid}/${tunnelLabel}`;
const agentLoaded = async (mac: MacTunnel) => (await mac.run(["launchctl", "print", agentTarget(mac)])).code === 0;

const agentPath = (mac: Pick<MacTunnel, "home">) => join(mac.home, "Library/LaunchAgents", `${tunnelLabel}.plist`);

async function removeAgent(mac: MacTunnel) {
  const agent = agentPath(mac);
  await readOwned(mac.home, agent, marker, "hub tunnel");
  if (await agentLoaded(mac)) await mac.run(["launchctl", "bootout", agentTarget(mac)]);
  await rm(agent, { force: true });
}

/** With nothing to forward, the doctor fails while an agent Fleet wrote is still on disk or loaded, and install and remove take it away. */
async function withoutTunnel(mode: MacTunnelMode, mac: MacTunnel) {
  const left = (await readOwned(mac.home, agentPath(mac), marker, "hub tunnel")) !== undefined || (mac.platform === "darwin" && (await agentLoaded(mac)));
  if (left && mode === "doctor") throw new Error(`The hub tunnel should go. ${nothingToForward} Run fleet hub-tunnel install to remove it.`);
  if (left && (mode === "install" || mode === "remove")) await removeAgent(mac);
  return mac.print(`Hub tunnel: not needed. ${nothingToForward}`), 0;
}

async function install(mac: MacTunnel, ports: number[], agent: string, domain: string, loaded: () => Promise<boolean>) {
  const changed = await changedFiles(mac.home, [wantedAgent(mac, ports, agent)], marker, "hub tunnel");
  if (changed.length) {
    if (await loaded()) await mac.run(["launchctl", "bootout", agentTarget(mac)]);
    await writeFiles(changed);
    mac.print("Hub tunnel: launch agent written. Stop any port-forward you started by hand, so the agent can use the ports.");
  }
  if (!(await loaded()) && (await mac.run(["launchctl", "bootstrap", domain, agent])).code !== 0) throw new Error("launchd did not load the hub tunnel.");
  if (!mac.gateway) return;
  const settings = { ...(mac.httpsHost ? { httpsHost: mac.httpsHost } : {}), relayPort: mac.relayPort };
  const client = await readGatewayClient(mac.home, settings);
  if (client && client.baseUrl !== localGatewayUrl) {
    await saveGatewayClient(mac.home, { ...client, baseUrl: localGatewayUrl }, settings);
    mac.print(`Hub tunnel: MCP clients use ${localGatewayUrl}.`);
  }
}

async function answers(mac: MacTunnel) {
  const response = await mac.fetch(`http://127.0.0.1:${gatewayPort}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  return response?.ok === true;
}
