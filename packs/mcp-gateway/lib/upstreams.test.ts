import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { gmail, googleApps, googleCalendar, slack } from "./apps.ts";
import { issueKey } from "./hub.ts";
import { declaredUpstreams } from "./declared.ts";
import { appSignedIn, registerUpstream, registerUpstreams, signInApp, upstreamsRegistered } from "./upstreams.ts";
import { dockerHost, fakeHub, fakeMcpHub, fakeRun, mcphubFetch, writeMcpHubSettings, type FakeContainer, type FakeMcpHub } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const olderGateway: FakeContainer = { Config: { Labels: { "org.fleet.service": "mcphub" }, Env: [] }, Image: "sha256:older", State: { Running: true }, Mounts: [] };
const notes = { kind: "oauth", name: "notes", title: "Notes", url: "https://notes.example.com/mcp", tools: ["search_notes", "read_note"] };
const mail = {
  kind: "codex-app", name: "mail", title: "Mail", app: "connector_mail", plugin: "mail@example-remote", prefix: "mail.",
  tools: ["read_*", "create_draft"], refusal: "Fleet's Mail route only reads mail and writes drafts.", account: "work",
};

function hubWith(declared: Record<string, unknown>, fields: Partial<FakeMcpHub> = {}) {
  const home = temp.make("upstreams-");
  writeMcpHubSettings(home);
  mkdirSync(join(home, ".local/share/fleet/codex/current/bin"), { recursive: true }), writeFileSync(join(home, ".local/share/fleet/codex/current/bin/codex"), "");
  const dir = join(home, ".config/fleet/mcp-gateway/upstreams");
  mkdirSync(dir, { recursive: true });
  for (const [file, value] of Object.entries(declared)) writeFileSync(join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
  const api = fakeMcpHub({ groups: [{ id: "g", name: "fleet", servers: ["tickets", "calendar"] }], ...fields });
  return { api, home, hub: fakeHub(home, { fetch: mcphubFetch(api), run: fakeRun(dockerHost(home, olderGateway)).run }) };
}

const writes = (api: FakeMcpHub) => api.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);

test("an OAuth upstream that a pack declares joins the gateway with its sign-in callback, and the Fleet group serves only its allowed tools", async () => {
  const { api, hub } = hubWith({ "notes.json": notes });
  expect(await upstreamsRegistered(hub)).toBe(false);
  await registerUpstreams(hub);
  expect(api.configs.notes).toEqual({ type: "streamable-http", url: "https://notes.example.com/mcp", description: "Added by Fleet", startOnDemand: true, oauth: { redirectUri: "http://127.0.0.1:3317/mcphub/oauth/callback" } });
  expect(api.groups[0]!.servers).toEqual(["tickets", "calendar", { name: "notes", tools: ["search_notes", "read_note"] }]);
  expect(hub.printed).toEqual(["Notes is in the MCP gateway. To sign in to it, on the hub, run: fleet mcp-gateway sign-in"]);
  expect(await upstreamsRegistered(hub)).toBe(true);
});

test("a second run changes nothing, and a group that serves more of the upstream's tools than it allows counts as missing until the run puts the list back", async () => {
  const { api, hub } = hubWith({ "notes.json": notes });
  await registerUpstreams(hub);
  api.calls.length = 0;
  await registerUpstreams(hub);
  expect(writes(api)).toEqual([]);
  api.groups[0]!.servers = ["tickets", "calendar", "notes"];
  expect(await upstreamsRegistered(hub)).toBe(false);
  await registerUpstreams(hub);
  expect(writes(api)).toEqual(["PUT groups/g"]);
  expect(api.groups[0]!.servers).toEqual(["tickets", "calendar", { name: "notes", tools: ["search_notes", "read_note"] }]);
});

test("a moved upstream keeps the sign-in that the gateway stored beside it", async () => {
  const { api, hub } = hubWith({ "notes.json": notes });
  await registerUpstreams(hub);
  api.configs.notes = { ...api.configs.notes, url: "https://old.example.com/mcp", oauth: { redirectUri: "http://127.0.0.1:3317/mcphub/oauth/callback", refreshToken: "kept" } };
  await registerUpstreams(hub);
  expect(api.configs.notes).toMatchObject({ url: "https://notes.example.com/mcp", oauth: { refreshToken: "kept" } });
});

test("a Codex app upstream that a pack declares runs Fleet's app bridge with its definition, in the Codex home of its account", async () => {
  const { api, home, hub } = hubWith({ "mail.json": mail });
  await registerUpstreams(hub);
  expect(api.configs.mail).toEqual({
    type: "stdio", command: "node", args: ["/app/fleet-app-bridge.mjs"], description: "Added by Fleet", startOnDemand: true, options: { timeout: 300000 },
    env: { HOME: "/app/data/work-codex", CODEX_HOME: "/app/data/work-codex", FLEET_CODEX_BIN: "/opt/fleet-codex/current/bin/codex", FLEET_APP: JSON.stringify(mail) },
  });
  expect(api.groups[0]!.servers).toEqual(["tickets", "calendar", "mail"]);
  expect(statSync(join(home, ".local/share/fleet-mcphub/data/work-codex")).mode & 0o777).toBe(0o700);
  expect(hub.printed.at(-1)).toBe("Sign Mail in to ChatGPT, with the account whose Mail app it should use. On the hub, run: fleet mcp-gateway sign-in mail");
  expect(await upstreamsRegistered(hub)).toBe(true);
});

test("keeps a server of the same name that Fleet did not add", async () => {
  const theirs = { type: "streamable-http", url: "https://other.example.com/mcp" };
  const { api, hub } = hubWith({ "notes.json": notes }, { servers: ["tickets", "calendar", "notes"], configs: { notes: theirs } });
  await expect(registerUpstreams(hub)).rejects.toThrow("Keep the MCP gateway's notes server: Fleet did not add it. Remove it in the gateway's dashboard to use Notes.");
  expect(api.configs.notes).toEqual(theirs);
  expect(writes(api)).toEqual([]);
});

test("a declared file that is not an upstream names its path and what is wrong", async () => {
  const cases: Array<[unknown, string]> = [
    ["{", "is not JSON"],
    [{ ...notes, kind: "socket" }, "kind must be oauth or codex-app"],
    [{ ...notes, name: "Notes!" }, "name must be lowercase letters, digits and dashes"],
    [{ ...notes, url: "http://notes.example.com/mcp" }, "url must be an https address"],
    [{ ...notes, tools: ["read_*"] }, "tools of an oauth upstream must be exact tool names"],
    [{ ...mail, refusal: undefined }, "refusal must be a sentence"],
    [{ ...notes, name: "slack" }, "name slack belongs to a built-in upstream"],
    [{ ...mail, app: slack.app }, "app, plugin and account must differ from those of the built-in Slack"],
    [{ ...mail, plugin: slack.plugin }, "app, plugin and account must differ from those of the built-in Slack"],
    [{ ...mail, account: "slack" }, "app, plugin and account must differ from those of the built-in Slack"],
    [{ ...mail, app: `${slack.app}.enabled=true #` }, "app must be a ChatGPT app id: letters, digits and underscores"],
    [{ ...mail, plugin: 'mail@x".enabled=true #' }, "plugin must be a Codex plugin name such as name@marketplace"],
    [{ ...mail, prefix: "mail" }, "prefix must be the app's tool prefix: lowercase letters, digits and underscores, then a dot"],
    [{ ...mail, account: undefined, name: "mail" }, ""],
  ];
  for (const [value, problem] of cases) {
    const { home } = hubWith({ "bad.json": value });
    if (!problem) expect(await declaredUpstreams(home)).toHaveLength(1);
    else await expect(declaredUpstreams(home)).rejects.toThrow(`${join(home, ".config/fleet/mcp-gateway/upstreams/bad.json")}: ${problem}`);
  }
  const { home } = hubWith({ "a.json": notes, "b.json": notes });
  await expect(declaredUpstreams(home)).rejects.toThrow(`${join(home, ".config/fleet/mcp-gateway/upstreams/b.json")}: name notes is declared twice`);
});

test("with no declared upstreams the check holds without asking the gateway, and other files in the folder are ignored", async () => {
  const { api, hub } = hubWith({ "README.md": "notes" });
  expect(await upstreamsRegistered(hub)).toBe(true);
  await registerUpstreams(hub);
  expect(api.calls).toEqual([]);
  expect(await declaredUpstreams(join(hub.home, "nowhere"))).toEqual([]);
});

test("every later sync of the Fleet group keeps a declared upstream's allowlist, also one that issues a machine key from an older view of the group", async () => {
  const { api, hub } = hubWith({ "notes.json": notes });
  await registerUpstreams(hub);
  api.groups[0]!.servers = ["tickets", "calendar"];
  await issueKey("box-1", hub);
  expect(api.groups[0]!.servers).toEqual(["tickets", "calendar", { name: "notes", tools: ["search_notes", "read_note"] }]);
  api.groups[0]!.servers = ["tickets", "calendar", "notes"];
  await issueKey("box-1", hub);
  expect(api.groups[0]!.servers).toEqual(["tickets", "calendar", { name: "notes", tools: ["search_notes", "read_note"] }]);
});

test("narrowing an upstream's tools keeps the rest of its group entry, and keeps only the pinned tools that stay allowed", async () => {
  const { api, hub } = hubWith({ "notes.json": notes }, { servers: ["tickets", "calendar", "notes"], configs: { notes: { type: "streamable-http", url: notes.url, description: "Added by Fleet" } } });
  api.groups[0]!.servers = ["tickets", { name: "notes", alias: "n", tools: "all", prompts: [], resources: [], pinnedTools: ["read_note", "delete_note"] }];
  await registerUpstreams(hub);
  expect(api.groups[0]!.servers).toEqual(["tickets", { name: "notes", alias: "n", tools: ["search_notes", "read_note"], prompts: [], resources: [], pinnedTools: ["read_note"] }, "calendar"]);
});

test("one ChatGPT sign-in serves every Google route and the gateway reloads all three, and signing in again replaces a broken sign-in", async () => {
  const { api, home, hub } = hubWith({});
  for (const app of googleApps) await registerUpstream(hub, app);
  const codex = join(home, ".local/share/fleet/codex/current/bin/codex");
  writeFileSync(codex, `#!/bin/sh\necho "$*" >> "${home}/logins"\necho '{}' > "$CODEX_HOME/auth.json"\n`);
  chmodSync(codex, 0o755);
  api.calls.length = 0;
  expect(await signInApp(hub, gmail)).toBe(0);
  for (const app of googleApps) expect(await appSignedIn(hub, app)).toBe(true);
  expect(writes(api)).toEqual(["POST servers/gmail/reload", "POST servers/google-calendar/reload", "POST servers/google-drive/reload"]);
  expect(await appSignedIn(hub, slack)).toBe(false);
  writeFileSync(join(home, ".local/share/fleet-mcphub/data/google-codex/auth.json"), "broken");
  api.calls.length = 0;
  expect(await signInApp(hub, googleCalendar)).toBe(0);
  expect(readFileSync(join(home, "logins"), "utf8")).toBe("login --device-auth\nlogin --device-auth\n");
  expect(readFileSync(join(home, ".local/share/fleet-mcphub/data/google-codex/auth.json"), "utf8")).toBe("{}\n");
  expect(writes(api)).toEqual(["POST servers/gmail/reload", "POST servers/google-calendar/reload", "POST servers/google-drive/reload"]);
});

test("a sign-in reloads every Google route even when the gateway fails to list one route's tools", async () => {
  const { api, home, hub } = hubWith({});
  for (const app of googleApps) await registerUpstream(hub, app);
  const codex = join(home, ".local/share/fleet/codex/current/bin/codex");
  writeFileSync(codex, `#!/bin/sh\necho '{}' > "$CODEX_HOME/auth.json"\n`);
  chmodSync(codex, 0o755);
  const gateway = hub.fetch;
  let gmailReloaded = false;
  hub.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/servers/gmail/reload")) gmailReloaded = true;
    if (gmailReloaded && url.endsWith("/api/servers/gmail") && (init?.method ?? "GET") === "GET") return new Response(null, { status: 500 });
    return gateway(input, init);
  };
  api.calls.length = 0;
  expect(await signInApp(hub, gmail)).toBe(0);
  expect(writes(api)).toEqual(["POST servers/gmail/reload", "POST servers/google-calendar/reload", "POST servers/google-drive/reload"]);
});

test("two Google sign-ins that overlap each finish, and the one that finishes last stays", async () => {
  const { home, hub } = hubWith({});
  for (const app of googleApps) await registerUpstream(hub, app);
  const [started, release] = [join(home, "started"), join(home, "release")];
  expect(await Bun.spawn(["mkfifo", started, release]).exited).toBe(0);
  const codex = join(home, ".local/share/fleet/codex/current/bin/codex");
  writeFileSync(codex, `#!/bin/sh\nif mkdir "${home}/first" 2>/dev/null; then\n  echo first > "$CODEX_HOME/auth.json"\n  echo > "${started}"\n  read go < "${release}"\nelse\n  echo second > "$CODEX_HOME/auth.json"\nfi\n`);
  chmodSync(codex, 0o755);
  const first = signInApp(hub, gmail);
  await readFile(started);
  const second = await signInApp(hub, googleCalendar).catch((error: Error) => error.message);
  await writeFile(release, "go\n");
  expect(second).toBe(0);
  expect(await first).toBe(0);
  expect(readFileSync(join(home, ".local/share/fleet-mcphub/data/google-codex/auth.json"), "utf8")).toBe("first\n");
});

test("a group entry whose server is named like an object property keeps its own tool selection", async () => {
  const { api, hub } = hubWith({}, { servers: ["tickets", "constructor"] });
  api.groups[0]!.servers = ["tickets", { name: "constructor", tools: ["read"] }];
  await issueKey("box-1", hub);
  expect(api.groups[0]!.servers).toEqual(["tickets", { name: "constructor", tools: ["read"] }]);
});
