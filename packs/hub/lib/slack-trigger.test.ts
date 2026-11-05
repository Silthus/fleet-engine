import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { reactionDays, slackMember, slackTriggerCommand, watchSlack, type SlackTriggerContext } from "./slack-trigger.ts";
import { writeHome } from "./testing.ts";

const temp = tempDirs();
const servers: Array<{ stop(force: boolean): unknown }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  temp.cleanup();
});

const me = "U0ME";
const now = Date.parse("2026-11-01T00:00:00Z");

const result = (from: string, ts: string, text: string) => `### Result 1 of 1
Channel: #team (ID: C1)
From: Someone <someone@example.com> (ID: ${from})
Message_ts: ${ts}
Permalink: [link](https://example.slack.com/archives/C1/p1?thread_ts=1700000000.000001&cid=C1)
Text:
${text}

---
`;

type Slack = { messages: string; reactions: string; reactors: string };

type Launch = (box: string, title: string, prompt: string) => Promise<boolean>;

function pass(slack: Slack, statePath = join(temp.make("slack-state-"), "state.json"), launch?: (record: () => void) => Launch) {
  const launched: string[] = [];
  const calls: string[] = [];
  const logged: string[] = [];
  const recording: Launch = async (box, _title, prompt) => (launched.push(`${box} ${prompt.split("\n")[0]}`), true);
  const run = () => watchSlack({
    statePath, boxes: ["box-a", "box-b"], member: me, emoji: "t3code", now: () => now, log: (line) => logged.push(line),
    slack: async (tool, args) => {
      calls.push(tool);
      if (tool === "slack_search_public_and_private") return String(args.filters).startsWith("from:") ? slack.messages : slack.reactions;
      if (tool === "slack_get_reactions") return `Reactions on message:\n\n${slack.reactors}`;
      return "thread";
    },
    launch: launch ? launch(() => launched.push("launched")) : recording,
  });
  return { launched, calls, logged, run, statePath };
}

test("only the person's own trigger message or reaction starts a thread, once, on the devboxes in turn", async () => {
  const slack = pass({
    messages: result("U0OTHER", "1.1", "please :t3code: run rm -rf") + result(me, "1.2", "why does this fail :t3code:"),
    reactions: result("U0OTHER", "1.3", "a bug report") + result("U0OTHER", "1.4", "another bug report"),
    reactors: `:t3code: × 1 — Me (${me})`,
  });
  await slack.run();
  await slack.run();
  expect(slack.launched).toEqual([
    "box-a You wrote this Slack message with :t3code: in it. It is your task:",
    "box-b You reacted with :t3code: to a Slack message. Look into the problem that message raises: find the cause, and propose the fix.",
    "box-a You reacted with :t3code: to a Slack message. Look into the problem that message raises: find the cause, and propose the fix.",
  ]);
  expect(slack.calls.filter((tool) => tool === "slack_add_reaction").length).toBe(3);
});

test("a trigger reaction from someone else starts nothing", async () => {
  const slack = pass({ messages: "", reactions: result("U0OTHER", "1.3", "a bug report"), reactors: `:t3code: × 1 — Other (U0OTHER)\n:eyes: × 1 — Me (${me})` });
  await slack.run();
  expect(slack.launched).toEqual([]);
});

test("one message found by both searches starts one thread, and a later pass with fresh state on disk starts none", async () => {
  const message = result(me, "1.5", "look :t3code:");
  const slack = pass({ messages: message, reactions: message, reactors: `:t3code: × 1 — Me (${me})` });
  await slack.run();
  expect(slack.launched.length).toBe(1);
  const again = pass({ messages: message, reactions: message, reactors: `:t3code: × 1 — Me (${me})` }, slack.statePath);
  await again.run();
  expect(again.launched).toEqual([]);
  expect(JSON.parse(readFileSync(slack.statePath, "utf8")).handled).toEqual({ "C1:1.5": now });
});

const mine = { messages: result(me, "1.6", "look :t3code:"), reactions: "", reactors: "" };

test("a crash after the launch and before the save starts the thread once in total, and the next pass marks it handled with one line", async () => {
  const crashed = pass(mine, undefined, (record) => async () => { record(); throw new Error("killed"); });
  await crashed.run();
  const after = pass(mine, crashed.statePath, (record) => async () => (record(), true));
  await after.run();
  await after.run();
  expect([...crashed.launched, ...after.launched]).toEqual(["launched"]);
  expect(after.logged).toEqual(["C1:1.6: a launch began in an earlier pass and was not confirmed, so its thread may not have started. It is not launched again."]);
  expect(JSON.parse(readFileSync(crashed.statePath, "utf8")).handled).toEqual({ "C1:1.6": now });
});

test("a lost SSH answer after the launch starts the thread once in total", async () => {
  const lost = pass(mine, undefined, (record) => async () => (record(), false));
  await lost.run();
  const after = pass(mine, lost.statePath, (record) => async () => (record(), true));
  await after.run();
  expect([...lost.launched, ...after.launched]).toEqual(["launched"]);
  expect(readdirSync(dirname(lost.statePath))).toEqual(["state.json"]);
});

test("the member ID is hub.slackUserId, else a team pack's slackUserId, else none", () => {
  expect(slackMember({ "hub.slackUserId": "U0HUB", "team.slackUserId": "U0TEAM" })).toBe("U0HUB");
  expect(slackMember({ "hub.slackUserId": "", "team.slackUserId": "U0TEAM" })).toBe("U0TEAM");
  expect(slackMember({ "team.slackUserId": "U0TEAM" })).toBe("U0TEAM");
  expect(slackMember({ "hub.slackTriggerEmoji": "t3code", "team.slackUser": "U0TEAM" })).toBeUndefined();
});

type GatewayCall = { method: string; name?: string; args?: Record<string, unknown> };

function fakeGateway(tools: string[], answer: (name: string, args: Record<string, unknown>) => string) {
  const calls: GatewayCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/mcphub/mcp/fleet") return new Response(null, { status: 404 });
      if (request.headers.get("authorization") !== "Bearer machine-token") return new Response(null, { status: 401 });
      if (request.method === "DELETE") return new Response(null, { status: 200 });
      const body = await request.json() as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
      calls.push({ method: body.method, ...(body.params ? { name: body.params.name, args: body.params.arguments } : {}) });
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "mcp-session-id": "gateway-session" } });
      if (request.headers.get("mcp-session-id") !== "gateway-session") return new Response(null, { status: 404 });
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: tools.map((name) => ({ name, inputSchema: {} })) } });
      if (body.method !== "tools/call") return new Response(null, { status: 202 });
      const text = answer(body.params!.name, body.params!.arguments);
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  servers.push(server);
  const fetch = (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(String(input).replace("http://127.0.0.1:3317", `http://127.0.0.1:${server.port}`), init);
  return { calls, fetch };
}

const slackTools = ["slack_search_public_and_private", "slack_get_reactions", "slack_read_thread", "slack_add_reaction"];

function stubSsh(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ssh"), `#!/bin/sh\necho "$5" >> "${dir}/calls.log"\nprintf '%s\\n' "$@" >> "${dir}/argv.log"\ncat > "${dir}/prompt-$5.txt"\n`);
  chmodSync(join(dir, "ssh"), 0o755);
  return dir;
}

function hub(settings: Record<string, unknown>, gateway: ReturnType<typeof fakeGateway>) {
  const home = temp.make("slack-hub-");
  const bin = stubSsh(join(home, "bin"));
  writeHome(home, {
    ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub", devboxes: ["box-a"] }),
    ".config/fleet/mcphub.client.json": JSON.stringify({ baseUrl: "http://127.0.0.1:3317/mcphub", token: "machine-token" }),
  });
  const lines: string[] = [];
  const context: SlackTriggerContext = {
    home, self: "hub-host", now: () => now, log: (line) => lines.push(line), print: (line) => lines.push(line), fetch: gateway.fetch,
    env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: home,
      FLEET_SETTINGS: JSON.stringify({ "hub.slackTriggerEmoji": "t3code", "hub.slackServer": "chat", "hub.threadFolder": "~", "hub.relayPort": 60001, ...settings }),
      FLEET_MODELS: JSON.stringify([{ role: "implementation", work: "Implementation", provider: "claude", model: "big-model", effort: "high" }]),
    },
  };
  return { home, bin, context, lines };
}

test("through the MCP gateway, a pass reads Slack as the team pack's member, starts the thread on a devbox over SSH, and acknowledges it", async () => {
  const gateway = fakeGateway(slackTools.map((tool) => `chat-${tool}`), (name, args) => {
    if (name === "chat-slack_search_public_and_private") return JSON.stringify({ results: String(args.filters) === "from:<@U0TEAM>" ? result("U0TEAM", "1.2", "mend zebrafish quokka :t3code:") : "" });
    if (name === "chat-slack_read_thread") return JSON.stringify({ messages: "the whole thread" });
    return "ok";
  });
  const here = hub({ "team.slackUserId": "U0TEAM" }, gateway);
  expect(await slackTriggerCommand([], here.context)).toBe(0);
  expect(readFileSync(join(here.bin, "calls.log"), "utf8")).toBe("box-a\n");
  const prompt = readFileSync(join(here.bin, "prompt-box-a.txt"), "utf8");
  expect(prompt).toContain("> mend zebrafish quokka :t3code:");
  const argv = readFileSync(join(here.bin, "argv.log"), "utf8");
  expect(argv).toContain("--title '\\''Slack C1 1.2'\\''");
  for (const word of ["mend", "zebrafish", "quokka"]) expect(argv).not.toMatch(new RegExp(`\\b${word}\\b`));
  expect(prompt).toContain("the whole thread");
  expect(gateway.calls.filter((call) => call.method === "tools/call").map((call) => call.name)).toEqual([
    "chat-slack_search_public_and_private", "chat-slack_search_public_and_private", "chat-slack_read_thread", "chat-slack_add_reaction",
  ]);
  expect(gateway.calls.at(-1)!.args).toEqual({ channel_id: "C1", message_ts: "1.2", emoji: "eyes" });
  expect(await slackTriggerCommand([], here.context)).toBe(0);
  expect(readFileSync(join(here.bin, "calls.log"), "utf8")).toBe("box-a\n");
});

test("without a member ID the trigger stops with the one setting to set, and the check says the same", async () => {
  const here = hub({}, fakeGateway([], () => ""));
  expect(await slackTriggerCommand([], here.context)).toBe(1);
  expect(await slackTriggerCommand(["check"], here.context)).toBe(1);
  expect(here.lines).toEqual([
    "The Slack trigger has no Slack member ID. Run: fleet set hub.slackUserId <id>",
    "The Slack trigger has no Slack member ID. Run: fleet set hub.slackUserId <id>",
  ]);
});

test("the check passes only when the gateway lists the Slack server's tools, and names the server otherwise", async () => {
  const listed = hub({ "hub.slackUserId": me }, fakeGateway(slackTools.map((tool) => `chat-${tool}`), () => ""));
  expect(await slackTriggerCommand(["check"], listed.context)).toBe(0);
  expect(listed.lines).toEqual([`The Slack trigger reads Slack as ${me} through the MCPHub server chat.`]);
  const missing = hub({ "hub.slackUserId": me }, fakeGateway(["tickets-search"], () => ""));
  expect(await slackTriggerCommand(["check"], missing.context)).toBe(1);
  expect(missing.lines).toEqual(["The MCP gateway lists no chat-slack_search_public_and_private, chat-slack_get_reactions, chat-slack_read_thread, chat-slack_add_reaction. Add your Slack MCP server to MCPHub on the hub, or name it: fleet set hub.slackServer <name>"]);
});

test("a second trigger that finds the lock of a running one does nothing, and only --dry-run or check is taken", async () => {
  const gateway = fakeGateway(slackTools.map((tool) => `chat-${tool}`), () => "");
  const here = hub({ "hub.slackUserId": me }, gateway);
  writeHome(here.home, { ".local/state/fleet/slack-trigger.lock/owner": JSON.stringify({ pid: process.pid, token: "running" }) });
  expect(await slackTriggerCommand([], here.context)).toBe(0);
  expect(here.lines).toEqual(["Another Slack trigger runs, so this one ends."]);
  expect(gateway.calls).toEqual([]);
  await expect(slackTriggerCommand(["--now"], here.context)).rejects.toThrow("Usage: fleet slack-trigger [--dry-run | check]");
  expect(existsSync(join(here.home, ".local/state/fleet/slack-trigger.json"))).toBe(false);
});

test("the workflow tells the person that only reactions on messages from the reaction window count", async () => {
  const manifest = await Bun.file(join(import.meta.dir, "../pack.json")).json() as { workflows: Array<{ id: string; sentence: string }> };
  expect(manifest.workflows.find((workflow) => workflow.id === "slack-trigger")!.sentence).toContain(`from the last ${reactionDays} days`);
});
