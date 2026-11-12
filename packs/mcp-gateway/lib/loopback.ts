import { createHash, randomBytes } from "node:crypto";
import type { OauthUpstream } from "./apps.ts";
import type { Fetch } from "./client.ts";
import { managementApi, type Hub } from "./hub.ts";

export const handCallback = "http://127.0.0.1:3399/callback";

type Config = Record<string, unknown>;
type AuthorizationServer = { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string };

const timeout = () => AbortSignal.timeout(15000);
const secure = (value: unknown): value is string => typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:";
const oauthOf = (config: Config | undefined) => (typeof config?.oauth === "object" && config.oauth !== null ? (config.oauth as Config) : {});

export const loopbackClientOf = (config: Config | undefined) => {
  const oauth = oauthOf(config);
  return oauth.redirectUri === handCallback && typeof oauth.clientId === "string" ? oauth.clientId : undefined;
};

export const loopbackSignedIn = (config: Config | undefined) => typeof oauthOf(config).accessToken === "string" || typeof oauthOf(config).refreshToken === "string";

async function issuerOf(fetch: Fetch, url: string) {
  const resource = new URL(url);
  const response = await fetch(`${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`, { signal: timeout() }).catch(() => undefined);
  const named = response?.ok ? ((await response.json().catch(() => ({}))) as { authorization_servers?: unknown[] }).authorization_servers?.[0] : undefined;
  return secure(named) ? new URL(named) : new URL(resource.origin);
}

async function authorizationServer(fetch: Fetch, upstream: OauthUpstream): Promise<AuthorizationServer> {
  const issuer = await issuerOf(fetch, upstream.url);
  const response = await fetch(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, "")}`, { signal: timeout() });
  if (!response.ok) throw new Error(`${upstream.title} publishes no OAuth server details: HTTP ${response.status}`);
  const server = (await response.json()) as Record<string, unknown>;
  if (!secure(server.authorization_endpoint) || !secure(server.token_endpoint)) throw new Error(`${upstream.title} names no https sign-in and token addresses`);
  return { authorization_endpoint: server.authorization_endpoint, token_endpoint: server.token_endpoint, ...(secure(server.registration_endpoint) && { registration_endpoint: server.registration_endpoint }) };
}

export async function registerLoopbackClient(fetch: Fetch, upstream: OauthUpstream) {
  const server = await authorizationServer(fetch, upstream);
  if (!server.registration_endpoint) throw new Error(`${upstream.title} does not register OAuth clients, so the gateway cannot sign in to it`);
  const response = await fetch(server.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Fleet MCP gateway", redirect_uris: [handCallback], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...(upstream.scopes && { scope: upstream.scopes.join(" ") }),
    }),
    signal: timeout(),
  });
  if (!response.ok) throw new Error(`${upstream.title} refused the gateway's OAuth client: HTTP ${response.status}`);
  const id = ((await response.json()) as { client_id?: unknown }).client_id;
  if (typeof id !== "string" || !id) throw new Error(`${upstream.title} registered the gateway's OAuth client without an id`);
  return id;
}

export async function firstLine(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes("\n")) break;
  }
  return text.split("\n")[0]!.trim();
}

function returnedCode(pasted: string, state: string, title: string) {
  if (!URL.canParse(pasted)) throw new Error("The paste is not an address. Run the sign-in again, and paste the full address from the browser's address bar.");
  const back = new URL(pasted);
  if (`${back.origin}${back.pathname}` !== handCallback) throw new Error(`The pasted address does not start with ${handCallback}. Run the sign-in again, and paste the address that the browser could not load.`);
  if (back.searchParams.get("state") !== state) throw new Error("The pasted address belongs to another sign-in. Run the sign-in again, and paste the address it leads to.");
  const refused = back.searchParams.get("error");
  if (refused) throw new Error(`${title} refused the sign-in: ${refused}`);
  const code = back.searchParams.get("code");
  if (!code) throw new Error("The pasted address holds no sign-in code. Run the sign-in again.");
  return code;
}

export async function signInLoopback(hub: Hub, upstream: OauthUpstream, readLine: () => Promise<string>) {
  const call = await managementApi(hub);
  const path = `servers/${encodeURIComponent(upstream.name)}`;
  const config = (await call<{ config: Config }>(path)).config;
  const clientId = loopbackClientOf(config);
  if (!clientId) throw new Error(`The MCP gateway has no OAuth client for ${upstream.title} yet. On the hub, run: fleet apply`);
  const server = await authorizationServer(hub.fetch, upstream);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const address = new URL(server.authorization_endpoint);
  address.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: handCallback, state, resource: upstream.url,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...(upstream.scopes && { scope: upstream.scopes.join(" ") }),
  }).toString();
  hub.print(`Open this address and sign in to ${upstream.title}. The browser then fails to load a 127.0.0.1 page. Copy the full address from its address bar and paste it here.`);
  hub.print(address.href);
  const code = returnedCode(await readLine(), state, upstream.title);
  const response = await hub.fetch(server.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: handCallback, client_id: clientId, code_verifier: verifier, resource: upstream.url }).toString(),
    signal: timeout(),
  });
  if (!response.ok) throw new Error(`${upstream.title} did not accept the sign-in code: HTTP ${response.status}. Run the sign-in again.`);
  const tokens = (await response.json()) as { access_token?: unknown; refresh_token?: unknown };
  if (typeof tokens.access_token !== "string") throw new Error(`${upstream.title} answered the sign-in without an access token. Run the sign-in again.`);
  const oauth: Config = { ...oauthOf(config), accessToken: tokens.access_token };
  delete oauth.pendingAuthorization;
  delete oauth.refreshToken;
  if (typeof tokens.refresh_token === "string") oauth.refreshToken = tokens.refresh_token;
  await call(path, "PUT", { config: { ...config, oauth } });
  await call(`${path}/reload`, "POST");
  hub.print(typeof tokens.refresh_token === "string"
    ? `${upstream.title} signed in. Agents on every machine reach it through the gateway now.`
    : `${upstream.title} signed in without a refresh token, so the sign-in ends when its access token does.`);
  return 0;
}
