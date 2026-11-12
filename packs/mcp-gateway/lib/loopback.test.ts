import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import type { OauthUpstream } from "./apps.ts";
import { signIn } from "./hub.ts";
import { firstLine, signInLoopback } from "./loopback.ts";
import { registerUpstreams, upstreamsRegistered } from "./upstreams.ts";
import { fakeHub, fakeMcpHub, mcphubFetch, writeMcpHubSettings, type FakeMcpHub } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const pages: OauthUpstream = { kind: "oauth", name: "pages", title: "Pages", url: "https://pages.example.com/mcp", loopback: true, scopes: ["pages", "offline_access"] };
const callback = "http://127.0.0.1:3399/callback";

function pagesServer() {
  const seen = { registrations: [] as Record<string, unknown>[], exchanges: [] as URLSearchParams[], grantedFor: "" };
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: pages.url, authorization_servers: ["https://auth.pages.example.com"] });
    if (url.origin !== "https://auth.pages.example.com") return new Response(null, { status: 404 });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({ authorization_endpoint: "https://auth.pages.example.com/authorize", token_endpoint: "https://auth.pages.example.com/token", registration_endpoint: "https://auth.pages.example.com/register" });
    }
    if (url.pathname === "/register") {
      const body = JSON.parse(String(init.body)) as { redirect_uris: string[] };
      seen.registrations.push(body);
      if (body.redirect_uris.some((uri) => !uri.startsWith("http://127.0.0.1:"))) return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
      return Response.json({ client_id: `client-${seen.registrations.length}` }, { status: 201 });
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(String(init.body));
      seen.exchanges.push(form);
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (form.get("code") !== "the-code" || challenge !== seen.grantedFor || form.get("redirect_uri") !== callback) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer" });
    }
    return new Response(null, { status: 404 });
  };
  return { seen, fetch };
}

function hubWithPages(fields: Partial<FakeMcpHub> = {}) {
  const home = temp.make("loopback-");
  writeMcpHubSettings(home);
  const dir = join(home, ".config/fleet/mcp-gateway/upstreams");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pages.json"), JSON.stringify(pages));
  const api = fakeMcpHub({ groups: [{ id: "g", name: "fleet", servers: ["tickets", "calendar"] }], ...fields });
  const gateway = mcphubFetch(api);
  const upstream = pagesServer();
  const fetch = (input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).hostname.endsWith("pages.example.com") ? upstream.fetch(input, init) : gateway(input, init));
  const hub = fakeHub(home, { fetch, gateway: { httpsHost: "hub.example.com", relayPort: 60001 } });
  return { api, hub, home, upstream };
}

const approve = (printed: string[], upstream: ReturnType<typeof pagesServer>, code = "the-code", stateOf = (state: string) => state) => {
  const address = new URL(printed.findLast((line) => line.startsWith("https://auth.pages.example.com/authorize"))!);
  upstream.seen.grantedFor = address.searchParams.get("code_challenge")!;
  return `${callback}?code=${code}&state=${stateOf(address.searchParams.get("state")!)}&iss=https%3A%2F%2Fauth.pages.example.com`;
};

test("an upstream that accepts only loopback callbacks joins the gateway with a client the gateway registered for its loopback callback alone, never the hub's HTTPS one", async () => {
  const { api, hub, upstream } = hubWithPages();
  await registerUpstreams(hub);
  expect(upstream.seen.registrations).toEqual([{
    client_name: "Fleet MCP gateway", redirect_uris: [callback], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "pages offline_access",
  }]);
  expect(api.configs.pages).toEqual({ type: "streamable-http", url: pages.url, description: "Added by Fleet", startOnDemand: true, oauth: { redirectUri: callback, scopes: ["pages", "offline_access"], clientId: "client-1" } });
  expect(hub.printed).toEqual(["Pages is in the MCP gateway. To sign in to it, on the hub, run: fleet mcp-gateway sign-in pages"]);
  expect(await upstreamsRegistered(hub)).toBe(true);
  await registerUpstreams(hub);
  expect(upstream.seen.registrations).toHaveLength(1);
});

test("an upstream in the group without a client, or with a client for the hub's HTTPS callback, is not ready, and the gateway registers a loopback client in its place", async () => {
  const { api, hub, upstream } = hubWithPages({ servers: ["tickets", "calendar", "pages"], groups: [{ id: "g", name: "fleet", servers: ["tickets", "calendar", "pages"] }] });
  const base = { type: "streamable-http", url: pages.url, description: "Added by Fleet", startOnDemand: true };
  api.configs.pages = { ...base, oauth: { redirectUri: callback, scopes: ["pages", "offline_access"] } };
  expect(await upstreamsRegistered(hub)).toBe(false);
  api.configs.pages = { ...base, oauth: { redirectUri: "https://hub.example.com:60001/mcphub/oauth/callback", clientId: "hub-client", refreshToken: "grant-of-hub-client" } };
  await registerUpstreams(hub);
  expect(api.configs.pages!.oauth).toEqual({ redirectUri: callback, scopes: ["pages", "offline_access"], clientId: "client-1" });
  expect(upstream.seen.registrations).toHaveLength(1);
});

test("the hand sign-in exchanges the pasted code with its PKCE verifier, and stores the grant only in the hub's gateway, never printing it", async () => {
  const { api, hub, upstream } = hubWithPages();
  await registerUpstreams(hub);
  api.configs.pages = { ...api.configs.pages, oauth: { ...(api.configs.pages!.oauth as object), pendingAuthorization: { authorizationUrl: "https://stale.example.com" } } };
  hub.printed.length = 0;
  expect(await signInLoopback(hub, pages, async () => approve(hub.printed, upstream))).toBe(0);
  const address = new URL(hub.printed[1]!);
  expect(Object.fromEntries(address.searchParams)).toMatchObject({ response_type: "code", client_id: "client-1", redirect_uri: callback, resource: pages.url, code_challenge_method: "S256", scope: "pages offline_access" });
  expect(upstream.seen.exchanges.map((form) => [form.get("grant_type"), form.get("client_id"), form.get("resource")])).toEqual([["authorization_code", "client-1", pages.url]]);
  expect(api.configs.pages!.oauth).toEqual({ redirectUri: callback, scopes: ["pages", "offline_access"], clientId: "client-1", accessToken: "access-secret", refreshToken: "refresh-secret" });
  expect(api.calls.filter((call) => call.method === "POST").map((call) => call.path)).toContain("servers/pages/reload");
  expect(hub.printed.at(-1)).toBe("Pages signed in. Agents on every machine reach it through the gateway now.");
  expect(hub.printed.join("\n")).not.toMatch(/access-secret|refresh-secret|code_verifier/);
});

test("a pasted address from another sign-in, a refusal, or no code stores nothing", async () => {
  const { api, hub, upstream } = hubWithPages();
  await registerUpstreams(hub);
  const before = structuredClone(api.configs.pages);
  const pastes = [
    () => approve(hub.printed, upstream, "the-code", () => "someone-else"),
    () => `${approve(hub.printed, upstream)}&error=access_denied`,
    () => approve(hub.printed, upstream).replace("code=the-code&", ""),
    () => approve(hub.printed, upstream).replace(callback, "https://evil.example.com/callback"),
    () => "",
  ];
  const refusals = [];
  for (const paste of pastes) refusals.push(await signInLoopback(hub, pages, async () => paste()).then(() => "stored", (error: Error) => error.message.split(".")[0]));
  expect(refusals).toEqual([
    "The pasted address belongs to another sign-in",
    "Pages refused the sign-in: access_denied",
    "The pasted address holds no sign-in code",
    "The pasted address does not start with http://127",
    "The paste is not an address",
  ]);
  expect(upstream.seen.exchanges).toEqual([]);
  expect(api.configs.pages).toEqual(before);
});

test("sign-in names the command for a hand sign-in instead of the gateway's own link, until the upstream holds a grant", async () => {
  const { home } = hubWithPages();
  writeMcpHubSettings(home, { mcpServers: { tickets: { oauth: { pendingAuthorization: { authorizationUrl: "https://tickets.example.com/authorize" } } }, pages: { oauth: { pendingAuthorization: { authorizationUrl: "https://auth.pages.example.com/authorize?redirect_uri=https%3A%2F%2Fhub" } } } } });
  const waiting = fakeHub(home);
  await signIn(waiting);
  expect(waiting.printed).toEqual([
    "pages: on the hub, run: fleet mcp-gateway sign-in pages",
    "On your computer, keep this running while you sign in: coder port-forward my-hub --tcp 3317",
    "tickets: https://tickets.example.com/authorize",
  ]);
  writeMcpHubSettings(home, { mcpServers: { pages: { oauth: { refreshToken: "kept" } } } });
  const done = fakeHub(home);
  await signIn(done);
  expect(done.printed).toEqual(["No upstream server waits for a sign-in."]);
});

test("reads the pasted address from the first line of standard input, and stops reading there while the terminal stays open", async () => {
  const chunks = [`  ${callback}?code=a`, "&state=b\nmore"];
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks.shift(); if (chunk === undefined) controller.error(new Error("read past the pasted line")); else controller.enqueue(new TextEncoder().encode(chunk)); } }, { highWaterMark: 0 });
  expect(await firstLine(stream)).toBe(`${callback}?code=a&state=b`);
});
