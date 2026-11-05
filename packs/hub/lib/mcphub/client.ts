import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

export type GatewayClient = { baseUrl: string; token: string };
export type GatewaySettings = { httpsHost?: string; relayPort: number };
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const localGatewayUrl = "http://127.0.0.1:3317/mcphub";
export const gatewayGroup = "fleet";
export const grantHint = "On the hub, run: fleet mcphub grant <this machine's SSH name>";
const invalidClient = `~/.config/fleet/mcphub.client.json is not a key from your hub. ${grantHint}`;

export class GatewayClientError extends Error {}

export const clientPath = (home: string) => join(home, ".config/fleet/mcphub.client.json");

export function browserGatewayUrl(settings: GatewaySettings) {
  return settings.httpsHost ? `https://${settings.httpsHost}:${settings.relayPort}/mcphub` : localGatewayUrl;
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

export async function writePrivateFile(path: string, content: string) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function saveGatewayClient(home: string, value: unknown, settings: GatewaySettings) {
  const client = validClient(value, settings);
  const path = clientPath(home);
  await refuseLinks(home, path, "MCP gateway key path");
  await mkdir(join(home, ".config/fleet"), { recursive: true, mode: 0o700 });
  await writePrivateFile(path, `${JSON.stringify(client)}\n`);
}

export async function checkGateway(home: string, settings: GatewaySettings, fetch: Fetch): Promise<{ ok: boolean; line: string }> {
  let client: GatewayClient | undefined;
  try { client = await readGatewayClient(home, settings); }
  catch (error) { if (error instanceof GatewayClientError) return { ok: false, line: error.message }; throw error; }
  if (!client) return { ok: false, line: `This machine has no MCP gateway key. ${grantHint}` };
  const health = await fetch(new URL("/health", client.baseUrl).href, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  return health?.ok
    ? { ok: true, line: `The MCP gateway at ${client.baseUrl} answers.` }
    : { ok: false, line: `The MCP gateway at ${client.baseUrl} does not answer. ${client.baseUrl === localGatewayUrl ? "On the hub, run: fleet mcphub doctor" : `A devbox reaches it at ${localGatewayUrl} through its tunnel. ${grantHint}`}` };
}
