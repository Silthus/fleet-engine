import { afterEach, expect, test } from "bun:test";
import { tempDirs } from "../../../src/testing/git.ts";
import { boxCommand } from "./box-command.ts";
import { Coder } from "./coder.ts";
import { fakeMachine, start, writeHome } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const day = 86_400_000;
const keyId = "Ab3dE6gH9k";
const sessionToken = [keyId, "x".repeat(22)].join("-");
const cliSession = { ".config/coderv2/session": `${sessionToken}\n`, ".config/coderv2/url": "https://cli.example.com\n" };

type Answer = { status: number; body: unknown } | Error;
type Request = { url: string; token: string | null; signal: boolean };

function apiKey(expiresAt: number, lifetimeSeconds: number, loginType = "password") {
  return { id: keyId, user_id: "8f1c2c1e-0f7a-4b8e-9c55-0d6c2f3a1b11", last_used: "2026-10-31T23:50:00Z", expires_at: new Date(expiresAt).toISOString(), created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-31T23:50:00Z", login_type: loginType, scope: "all", scopes: ["all"], token_name: "", lifetime_seconds: lifetimeSeconds, allow_list: [{ type: "*", id: "*" }] };
}

function hubWith(files: Record<string, string>, answer: Answer | "network", env: Record<string, string> = {}) {
  const home = temp.make("fleet-coder-session-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub" }), ...files });
  const requests: Request[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    requests.push({ url, token: new Headers(init?.headers).get("Coder-Session-Token"), signal: init?.signal instanceof AbortSignal });
    if (answer === "network") throw new Error("the real network is in use");
    if (answer instanceof Error) throw answer;
    return Response.json(answer.body, { status: answer.status });
  }) as unknown as typeof fetch;
  const { machine, lines } = fakeMachine(home, { self: "my-hub", isHub: true });
  const coder = new Coder({ home, env, coderUrl: machine.settings.coderUrl, template: machine.settings.template, ...(answer === "network" ? {} : { fetch: fetcher }) });
  const run = () => boxCommand(["session"], { machine: () => machine, coder: () => coder, tokens: () => ({ here: machine, hub: "my-hub", coder }), print: machine.print, readStdin: async () => "", hooks: {} });
  return { run, lines, requests };
}

test("fleet box session passes when the hub's Coder session lasts more than 7 days, reading its key from Coder with that session", async () => {
  const hub = hubWith(cliSession, { status: 200, body: apiKey(start + 30 * day, 90 * 86_400, "token") });
  expect(await hub.run()).toBe(0);
  expect(hub.requests).toEqual([{ url: `https://cli.example.com/api/v2/users/me/keys/${keyId}`, token: sessionToken, signal: true }]);
  expect(hub.lines.join("\n")).toContain("2026-12-01T00:00:00.000Z");
});

test("fleet box session warns and names coder login with the Coder address when the session expires within 7 days", async () => {
  const hub = hubWith(cliSession, { status: 200, body: apiKey(start + 3 * day, 30 * 86_400, "token") });
  expect(await hub.run()).toBe(1);
  expect(hub.lines.join("\n")).toContain("expires at 2026-11-04T00:00:00.000Z");
  expect(hub.lines.join("\n")).toContain("coder login https://cli.example.com");
});

test("fleet box session warns when Coder rejects the session or its expiry has passed", async () => {
  const rejected = hubWith(cliSession, { status: 401, body: { message: "API key expired." } });
  expect(await rejected.run()).toBe(1);
  expect(rejected.lines.join("\n")).toMatch(/Coder rejects the hub's Coder session.*coder login https:\/\/cli\.example\.com/s);
  const past = hubWith(cliSession, { status: 200, body: apiKey(start - day, 30 * 86_400, "token") });
  expect(await past.run()).toBe(1);
  expect(past.lines.join("\n")).toContain("expired at 2026-10-31T00:00:00.000Z");
});

test("a sign-in session that Coder extends on use warns only in the last half of its lifetime, so a 24-hour session in use passes", async () => {
  const inUse = hubWith(cliSession, { status: 200, body: apiKey(start + 23 * 3_600_000, 86_400) });
  expect(await inUse.run()).toBe(0);
  const idle = hubWith(cliSession, { status: 200, body: apiKey(start + 2 * 3_600_000, 86_400) });
  expect(await idle.run()).toBe(1);
});

test("a session from Fleet's own session file names that file in the fix, since Fleet reads it before the Coder CLI's", async () => {
  const hub = hubWith({ ".config/fleet/coder-session": `${sessionToken}\n`, ".config/fleet/coder-url": "https://fleet.example.com\n" }, { status: 401, body: { message: "API key expired." } });
  expect(await hub.run()).toBe(1);
  expect(hub.requests[0]!.url).toStartWith("https://fleet.example.com/");
  expect(hub.lines.join("\n")).toContain("~/.config/fleet/coder-session");
});

test("fleet box session passes without a request when the hub has no Coder session at all", async () => {
  const hub = hubWith({}, new Error("no request expected"));
  expect(await hub.run()).toBe(0);
  expect(hub.requests).toEqual([]);
  expect(hub.lines.join("\n")).toContain("no Coder session");
});

test("fleet box session warns, and does not crash, when Coder does not answer in time", async () => {
  const hub = hubWith(cliSession, new DOMException("The operation timed out.", "TimeoutError"));
  expect(await hub.run()).toBe(1);
  expect(hub.requests.map((request) => request.signal)).toEqual([true]);
  expect(hub.lines.join("\n")).toMatch(/Cannot reach Coder at https:\/\/cli\.example\.com.*timed out/s);
});

test("on a machine that is not the hub, fleet box session refuses and says to run fleet hub here", async () => {
  const home = temp.make("fleet-coder-session-");
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "devbox" }) });
  const { machine } = fakeMachine(home);
  const coder = new Coder({ home, env: {}, coderUrl: machine.settings.coderUrl, template: machine.settings.template });
  await expect(boxCommand(["session"], { machine: () => machine, coder: () => coder, tokens: () => ({ here: machine, hub: "my-hub", coder }), print: machine.print, readStdin: async () => "", hooks: {} })).rejects.toThrow("Run fleet hub here on the hub");
});

test("fleet box session sends the session to no other address that Coder's address redirects to", async () => {
  const seen: Array<string | null> = [];
  const other = Bun.serve({ port: 0, fetch: (request) => (seen.push(request.headers.get("Coder-Session-Token")), Response.json(apiKey(start + 30 * day, 90 * 86_400, "token"))) });
  const coder = Bun.serve({ port: 0, fetch: (request) => Response.redirect(`${other.url.origin}${new URL(request.url).pathname}`, 302) });
  try {
    const hub = hubWith({ ".config/coderv2/session": `${sessionToken}\n`, ".config/coderv2/url": `${coder.url.origin}\n` }, "network");
    expect(await hub.run()).toBe(1);
    expect(seen).toEqual([]);
    expect(hub.lines.join("\n")).toContain("redirect");
  } finally {
    coder.stop(true);
    other.stop(true);
  }
});

test("fleet box session never prints the session token, not even one that cannot go in a header or that Coder echoes", async () => {
  const pasted = `${keyId}-pastedSecretPart\nsecondLineSecret`;
  const broken = hubWith({ ".config/coderv2/session": `${pasted}\n`, ".config/coderv2/url": "http://127.0.0.1:9\n" }, "network");
  expect(await broken.run()).toBe(1);
  expect(broken.lines.join("\n")).not.toMatch(/pastedSecretPart|secondLineSecret/);
  const echoed = hubWith(cliSession, { status: 500, body: { message: `bad key ${sessionToken}` } });
  expect(await echoed.run()).toBe(1);
  expect(echoed.lines.join("\n")).toContain("Coder answered 500");
  expect(echoed.lines.join("\n")).not.toContain("x".repeat(22));
});

test("a key that reports no lifetime still warns within 7 days of its expiry", async () => {
  const hub = hubWith(cliSession, { status: 200, body: apiKey(start + 3 * day, 0, "token") });
  expect(await hub.run()).toBe(1);
  expect(hub.lines.join("\n")).toContain("expires at 2026-11-04T00:00:00.000Z");
});

test("fleet box session prints no part of the session when Coder answers with something that is not an API key", async () => {
  const secret = "x".repeat(22);
  const coder = Bun.serve({ port: 0, fetch: () => new Response(`{"error": ${secret}}`, { headers: { "Content-Type": "application/json" } }) });
  try {
    const hub = hubWith({ ".config/coderv2/session": `${sessionToken}\n`, ".config/coderv2/url": `${coder.url.origin}\n` }, "network");
    expect(await hub.run()).toBe(1);
    expect(hub.lines.join("\n")).toContain("not an API key");
    expect(hub.lines.join("\n")).not.toContain(secret);
  } finally {
    coder.stop(true);
  }
});
