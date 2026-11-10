import { lstat, mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { writePrivateFile } from "../../../src/files/private.ts";

export { writePrivateFile };

export type GatewayClient = { baseUrl: string; token: string };
export type GatewaySettings = { httpsHost?: string; relayPort?: number };
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const gatewayPort = 3317;
export const localGatewayUrl = `http://127.0.0.1:${gatewayPort}/mcphub`;
export const gatewayGroup = "fleet";
export const grantHint = "On the hub, run: fleet mcp-gateway grant <this machine's SSH name>";
const invalidClient = `~/.config/fleet/mcphub.client.json is not a key from your hub. ${grantHint}`;

export class GatewayClientError extends Error {}

export const clientPath = (home: string) => join(home, ".config/fleet/mcphub.client.json");

export function browserGatewayUrl(settings: GatewaySettings) {
  return settings.httpsHost && settings.relayPort ? `https://${settings.httpsHost}:${settings.relayPort}/mcphub` : localGatewayUrl;
}

export function isGatewayUrl(url: string, settings: GatewaySettings) {
  return url === localGatewayUrl || url === browserGatewayUrl(settings);
}

export const gatewayEndpoint = (client: GatewayClient) => `${client.baseUrl}/mcp/${gatewayGroup}`;

function validClient(value: unknown, settings: GatewaySettings): GatewayClient {
  const client = value as Partial<GatewayClient> | null;
  if (typeof client?.baseUrl !== "string" || typeof client.token !== "string" || !isGatewayUrl(client.baseUrl, settings) || !/^[A-Za-z0-9_-]+$/.test(client.token)) {
    throw new GatewayClientError(invalidClient);
  }
  return { baseUrl: client.baseUrl, token: client.token };
}

export async function readGatewayClient(home: string, settings: GatewaySettings): Promise<GatewayClient | undefined> {
  let text: string;
  try { text = await readFile(clientPath(home), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try { return validClient(JSON.parse(text), settings); }
  catch { throw new GatewayClientError(invalidClient); }
}

export async function refuseLinks(home: string, target: string, what: string) {
  let path = home;
  for (const part of relative(home, target).split("/")) {
    path = join(path, part);
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Keep linked ${what}: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function saveGatewayClient(home: string, value: unknown, settings: GatewaySettings) {
  const client = validClient(value, settings);
  const path = clientPath(home);
  await refuseLinks(home, path, "MCP gateway key path");
  await mkdir(join(home, ".config/fleet"), { recursive: true, mode: 0o700 });
  await writePrivateFile(path, `${JSON.stringify(client)}\n`);
}

const fileClient = (home: string) => readGatewayClient(home, {}).catch((error) => { if (error instanceof GatewayClientError) return undefined; throw error; });

/** Keeps today's client file in step with the secret store, because box handover reads the file: the file follows the store, and a store without a key adopts the file's key. */
export async function syncClientFile(home: string, stored: string | undefined, store: (token: string) => Promise<void>) {
  const client = await fileClient(home);
  if (stored === undefined) {
    if (client) await store(client.token);
  } else if (client?.token !== stored) await saveGatewayClient(home, { baseUrl: localGatewayUrl, token: stored }, {});
}

export async function checkGateway(home: string, stored: string | undefined, fetch: Fetch): Promise<{ ok: boolean; line: string }> {
  if (stored === undefined) return { ok: false, line: `This machine has no MCP gateway key. ${grantHint}` };
  if ((await fileClient(home))?.token !== stored) return { ok: false, line: "~/.config/fleet/mcphub.client.json does not hold this machine's MCP gateway key. Run: fleet apply" };
  const health = await fetch(`http://127.0.0.1:${gatewayPort}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  return health?.ok
    ? { ok: true, line: `The MCP gateway at ${localGatewayUrl} answers.` }
    : { ok: false, line: `The MCP gateway at ${localGatewayUrl} does not answer. On the hub, run: fleet mcp-gateway doctor` };
}
