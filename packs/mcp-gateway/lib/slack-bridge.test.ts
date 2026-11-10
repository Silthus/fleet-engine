import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { registerSlackBridge, signInSlackBridge, slackBridgeRegistered, slackBridgeSignedIn } from "./slack-bridge.ts";
import { dockerHost, fakeHub, fakeMcpHub, fakeRun, mcphubFetch, writeMcpHubSettings, type FakeContainer, type FakeMcpHub } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const bridgeHome = (home: string) => join(home, ".local/share/fleet-mcphub/data/slack-codex");
const stored = {
  type: "stdio",
  command: "node",
  args: ["/app/fleet-slack-bridge.mjs"],
  env: { HOME: "/app/data/slack-codex", CODEX_HOME: "/app/data/slack-codex", FLEET_CODEX_BIN: "/opt/fleet-codex/current/bin/codex" },
  startOnDemand: true,
  options: { timeout: 300000 },
};
const signInHint = "Sign the Slack bridge in to ChatGPT, with the account whose Slack app it should use. On the hub, run: fleet mcp-gateway slack-bridge sign-in";

const olderGateway: FakeContainer = { Config: { Labels: { "org.fleet.service": "mcphub" }, Env: [] }, Image: "sha256:older", State: { Running: true }, Mounts: [] };

function hubWith(fields: Partial<FakeMcpHub> = {}, codex = true) {
  const home = temp.make("slack-bridge-");
  const docker = dockerHost(home, olderGateway);
  writeMcpHubSettings(home);
  if (codex) mkdirSync(join(home, ".local/share/fleet/codex/current/bin"), { recursive: true }), writeFileSync(join(home, ".local/share/fleet/codex/current/bin/codex"), "");
  const api = fakeMcpHub({ groups: [{ id: "g", name: "fleet", servers: ["tickets", "calendar"] }], configs: { tickets: { type: "streamable-http", url: "https://tickets.example.com/mcp" } }, ...fields });
  return { api, docker, hub: fakeHub(home, { fetch: mcphubFetch(api), run: fakeRun(docker).run }), home };
}

const writes = (api: FakeMcpHub) => api.calls.filter((call) => call.method !== "GET" && call.path.startsWith("servers"));

test("puts the bridge into the gateway as its own server, adds it to the Fleet group, and gives it a private Codex home", async () => {
  const { api, hub, home } = hubWith();
  await registerSlackBridge(hub);
  expect(api.configs).toEqual({ tickets: { type: "streamable-http", url: "https://tickets.example.com/mcp" }, slack: stored });
  expect(api.groups).toEqual([{ id: "g", name: "fleet", servers: ["tickets", "calendar", "slack"] }]);
  expect(statSync(bridgeHome(home)).mode & 0o777).toBe(0o700);
  expect(hub.printed).toEqual(["MCPHub installed: http://127.0.0.1:3317/mcphub/", "The Slack bridge is in the MCP gateway.", signInHint]);
  expect(await slackBridgeRegistered(hub)).toBe(true);
});

test("on a running gateway that an older Fleet installed, the gateway first moves to the image that holds the bridge, with Fleet's Codex mounted", async () => {
  const { docker, hub } = hubWith();
  await registerSlackBridge(hub);
  expect(docker.container()).toMatchObject({ Image: expect.stringMatching(/^sha256:fleet-mcphub:1\.1\.0-[0-9a-f]{12}$/), State: { Running: true } });
  expect(docker.container()!.Mounts).toContainEqual({ Destination: "/opt/fleet-codex" });
});

test("a second run changes nothing, and a run after someone edited the bridge puts it back", async () => {
  const { api, hub } = hubWith();
  await registerSlackBridge(hub);
  api.calls.length = 0;
  await registerSlackBridge(hub);
  expect(writes(api)).toEqual([]);
  api.configs.slack = { enabled: true, startOnDemand: true, options: { timeout: 300000 }, env: { FLEET_CODEX_BIN: stored.env.FLEET_CODEX_BIN, CODEX_HOME: stored.env.CODEX_HOME, HOME: stored.env.HOME }, args: stored.args, command: "node", type: "stdio" };
  expect(await slackBridgeRegistered(hub)).toBe(true);
  api.configs.slack = { ...stored, env: { ...stored.env, NODE_OPTIONS: "--require /tmp/other.js" } };
  expect(await slackBridgeRegistered(hub)).toBe(false);
  api.configs.slack = { ...stored, env: { ...stored.env, CODEX_HOME: "/app/data" } };
  expect(await slackBridgeRegistered(hub)).toBe(false);
  await registerSlackBridge(hub);
  expect(writes(api).map((call) => `${call.method} ${call.path}`)).toEqual(["PUT servers/slack"]);
  expect(api.configs.slack).toEqual(stored);
});

test("keeps a slack server that Fleet did not add", async () => {
  const theirs = { type: "stdio", command: "npx", args: ["some-slack-mcp"] };
  const { api, hub } = hubWith({ servers: ["tickets", "calendar", "slack"], configs: { slack: theirs } });
  await expect(registerSlackBridge(hub)).rejects.toThrow("Keep the MCP gateway's slack server: Fleet did not add it. Remove it in the gateway's dashboard to use the Slack bridge.");
  expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(api.configs.slack).toEqual(theirs);
});

test("fails when the gateway does not keep the bridge's settings", async () => {
  const { hub } = hubWith({ keepsConfig: false });
  await expect(registerSlackBridge(hub)).rejects.toThrow("The MCP gateway did not keep the Slack bridge's settings. Run: fleet mcp-gateway doctor");
});

test("needs the Codex that Fleet installs on the hub, and adds nothing without it", async () => {
  const { api, hub } = hubWith({}, false);
  await expect(registerSlackBridge(hub)).rejects.toThrow("The Slack bridge runs Codex, and this hub has no Codex from Fleet. Run: fleet install-codex");
  expect(writes(api)).toEqual([]);
});

test("the bridge counts as signed in once its own Codex home holds a ChatGPT sign-in", async () => {
  const { hub, home } = hubWith();
  await registerSlackBridge(hub);
  expect(await slackBridgeSignedIn(hub)).toBe(false);
  writeFileSync(join(bridgeHome(home), "auth.json"), "{}");
  expect(await slackBridgeSignedIn(hub)).toBe(true);
  expect(await slackBridgeSignedIn({ ...hub, home: join(home, "elsewhere") })).toBe(false);
});

test("sign-in runs Codex's device sign-in in the bridge's own Codex home, then reloads only the bridge so the gateway finds the Slack tools", async () => {
  const { api, hub, home } = hubWith();
  await registerSlackBridge(hub);
  const codex = join(home, ".local/share/fleet/codex/current/bin/codex");
  writeFileSync(codex, `#!/bin/sh\necho "$*" > "$CODEX_HOME/login-args"\necho '{}' > "$CODEX_HOME/auth.json"\n`);
  chmodSync(codex, 0o755);
  api.calls.length = 0;
  expect(await signInSlackBridge(hub)).toBe(0);
  expect(readFileSync(join(bridgeHome(home), "login-args"), "utf8")).toBe("login --device-auth\n");
  expect(await slackBridgeSignedIn(hub)).toBe(true);
  expect(api.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`)).toEqual(["POST servers/slack/reload"]);
});

test("a bridge already in the gateway still counts as missing while the gateway runs an older image, and registering moves the gateway to the bridge's image", async () => {
  const { api, docker, hub } = hubWith({ servers: ["tickets", "calendar", "slack"], configs: { slack: stored } });
  expect(await slackBridgeRegistered(hub)).toBe(false);
  await registerSlackBridge(hub);
  expect(docker.container()!.Mounts).toContainEqual({ Destination: "/opt/fleet-codex" });
  expect(await slackBridgeRegistered(hub)).toBe(true);
  expect(writes(api)).toEqual([]);
});

test("a turned-off bridge counts as missing, and registering turns it back on", async () => {
  const { api, hub } = hubWith();
  await registerSlackBridge(hub);
  api.configs.slack = { ...stored, enabled: false };
  expect(await slackBridgeRegistered(hub)).toBe(false);
  await registerSlackBridge(hub);
  expect(api.configs.slack.enabled).toBe(true);
  expect(await slackBridgeRegistered(hub)).toBe(true);
});

test("a slack server that someone adds while the gateway image builds is kept", async () => {
  const theirs = { type: "stdio", command: "npx", args: ["some-slack-mcp"] };
  const { api, hub, home } = hubWith();
  const docker = dockerHost(home, olderGateway);
  const run = fakeRun((call) => {
    if (call.command[1] === "run") api.servers.push("slack"), (api.configs.slack = theirs);
    return docker(call);
  }).run;
  await expect(registerSlackBridge({ ...hub, run })).rejects.toThrow("Keep the MCP gateway's slack server: Fleet did not add it.");
  expect(api.configs.slack).toEqual(theirs);
});
