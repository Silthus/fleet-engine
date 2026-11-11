import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { tempDirs } from "../../../src/testing/git.ts";
import { bridgeBundle } from "./install.ts";

const temp = tempDirs();
const running: Array<{ kill(): void }> = [];
afterEach(() => {
  for (const child of running.splice(0)) child.kill();
  temp.cleanup();
});

type Message = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: { message: string } };

const node = Bun.which("node");
let bundled = "";
beforeAll(async () => {
  bundled = join(mkdtempSync(join(tmpdir(), "bridge-bundle-")), "fleet-slack-bridge.mjs");
  writeFileSync(bundled, await bridgeBundle(join(import.meta.dir, "..")));
});
afterAll(() => rmSync(join(bundled, ".."), { recursive: true, force: true }));
const runtimes = { "the source under Bun": () => [process.execPath, join(import.meta.dir, "slack-upstream.ts")], "the image's bundle under Node": () => [node!, bundled] };
let launch = runtimes["the source under Bun"];

function upstream(config = "", backendEnv: Record<string, string> = {}) {
  const home = temp.make("slack-codex-");
  writeFileSync(join(home, "config.toml"), config);
  const codex = join(home, "codex");
  writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures/codex-app-server.ts")}" "$@"\n`);
  chmodSync(codex, 0o755);
  const log = join(home, "codex.log");
  const child = Bun.spawn(launch(), {
    env: { PATH: process.env.PATH, CODEX_HOME: home, FLEET_CODEX_BIN: codex, FAKE_CODEX_LOG: log, ...backendEnv },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  running.push(child);
  const waiting = new Map<number | string, (message: Message) => void>();
  const asked: Message[] = [];
  let answer: (request: Message) => unknown = () => ({ action: "decline" });
  const write = (message: Message) => { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); child.stdin.flush(); };
  createInterface({ input: require("node:stream").Readable.fromWeb(child.stdout) }).on("line", (line) => {
    const message = JSON.parse(line) as Message;
    if (message.method && message.id !== undefined) return asked.push(message), write({ id: message.id, result: answer(message) });
    waiting.get(message.id!)?.(message);
  });
  let exited: Message | undefined;
  void child.exited.then(async (code) => {
    exited = { error: { message: `the bridge exited with ${code}: ${await new Response(child.stderr).text()}` } };
    for (const resolve of waiting.values()) resolve(exited);
  });
  let next = 0;
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<Message>((resolve) => {
    if (exited) return resolve(exited);
    const id = ++next;
    waiting.set(id, resolve);
    write({ id, method, params });
  });
  const backend = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv?: string[]; method?: string; params?: any; approval?: unknown }) : []);
  const called = () => backend().filter((entry) => entry.method === "mcpServer/tool/call").map((entry) => entry.params.tool as string);
  return { request, backend, called, asked, close: () => child.stdin.end(), exited: child.exited, answer: (fn: typeof answer) => { answer = fn; }, initialize: () => request("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "test", version: "1" } }) };
}

for (const [runtime, command] of Object.entries(runtimes)) describe.skipIf(!node && command === runtimes["the image's bundle under Node"])(runtime, () => {
  beforeAll(() => { launch = command; });

  test("lists only Slack reads, drafts and canvases, and points send hints at the draft tool", async () => {
    const bridge = upstream();
    expect((await bridge.initialize()).result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    const tools = (await bridge.request("tools/list")).result.tools as Array<{ name: string; description: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["slack_send_message_draft", "slack_read_thread", "slack_create_canvas"]);
    expect(tools[0]!.description).toBe("Leaves an unsent draft.");
    expect(JSON.stringify(tools)).not.toMatch(/slack_send_message\b(?!_)/);
  });

  test("a draft reaches the Slack app, and a send is refused before it reaches it", async () => {
    const bridge = upstream();
    await bridge.initialize();
    const draft = await bridge.request("tools/call", { name: "slack_send_message_draft", arguments: { channel_id: "C1", message: "hi" } });
    expect(draft.result).toEqual({ content: [{ type: "text", text: "slack.slack_send_message_draft done" }] });
    for (const name of ["slack_send_message", "slack_add_reaction", "slack_delete_message"]) {
      const refused = await bridge.request("tools/call", { name, arguments: { channel_id: "C1", message: "hi" } });
      expect(refused.result).toEqual({ isError: true, content: [{ type: "text", text: "Fleet's Slack bridge only reads Slack, leaves unsent drafts, and writes canvases. Use slack_send_message_draft and let the person send it." }] });
    }
    expect(bridge.called()).toEqual(["slack.slack_send_message_draft"]);
    expect(bridge.backend().find((entry) => entry.method === "mcpServer/tool/call")!.params).toEqual({ threadId: "thread-1", server: "codex_apps", tool: "slack.slack_send_message_draft", arguments: { channel_id: "C1", message: "hi" } });
  });

  test("a draft's skin-tone shortcodes reach Slack as Unicode emoji, so Slack's markdown cannot double the tone, and code keeps them as written", async () => {
    const bridge = upstream();
    await bridge.initialize();
    const message = "Thanks :+1::skin-tone-2: and :wave::skin-tone-6: :unknown::skin-tone-3: `:+1::skin-tone-4:`\n```\n:clap::skin-tone-5:\n```";
    await bridge.request("tools/call", { name: "slack_send_message_draft", arguments: { channel_id: "C1", message, text: ":ok_hand::skin-tone-3:", title: ":+1::skin-tone-2:" } });
    expect(bridge.backend().find((entry) => entry.method === "mcpServer/tool/call")!.params.arguments).toEqual({
      channel_id: "C1",
      message: "Thanks \u{1F44D}\u{1F3FB} and \u{1F44B}\u{1F3FF} :unknown::skin-tone-3: `:+1::skin-tone-4:`\n```\n:clap::skin-tone-5:\n```",
      text: "\u{1F44C}\u{1F3FC}",
      title: ":+1::skin-tone-2:",
    });
  });

  test("the Codex backend serves only the Slack app: every MCP server and every other plugin stays off, and it uses its own OpenAI sign-in", async () => {
    const bridge = upstream('[mcp_servers.fleet-hub]\ncommand = "sh"\n[mcp_servers.other]\ncommand = "x"\n[plugins."slack@openai-curated-remote"]\nenabled = false\n[plugins."gmail@openai-curated-remote"]\nenabled = true\n');
    await bridge.initialize();
    await bridge.request("tools/list");
    expect(bridge.backend()[0]!.argv).toEqual([
      "-c", "features.apps=true", "-c", "apps.asdk_app_69a1d78e929881919bba0dbda1f6436d.enabled=true", "-c", 'model_provider="openai"',
      "-c", "mcp_servers.fleet-hub.enabled=false", "-c", "mcp_servers.other.enabled=false",
      "-c", 'plugins."slack@openai-curated-remote".enabled=true', "-c", 'plugins."gmail@openai-curated-remote".enabled=false',
      "app-server", "--stdio",
    ]);
  });

  test("every Slack call of one bridge runs in the same Codex thread, so calls do not pile up threads in the backend", async () => {
    const bridge = upstream();
    await bridge.initialize();
    for (const message of ["one", "two", "three"]) await bridge.request("tools/call", { name: "slack_send_message_draft", arguments: { message } });
    expect(bridge.called()).toHaveLength(3);
    expect(bridge.backend().filter((entry) => entry.method === "thread/start")).toHaveLength(1);
  });

  test("the bridge ends when the gateway closes it, even while the Codex backend has not answered yet", async () => {
    const bridge = upstream("", { FAKE_CODEX_SILENT: "1" });
    bridge.close();
    expect(await bridge.exited).toBe(0);
  });

  test("an approval the Slack app asks for goes to the calling agent, and its answer goes back", async () => {
    const bridge = upstream();
    await bridge.initialize();
    bridge.answer(() => ({ action: "accept", content: {} }));
    const draft = await bridge.request("tools/call", { name: "slack_send_message_draft", arguments: { ask: true } });
    expect(draft.result.content).toEqual([{ type: "text", text: "slack.slack_send_message_draft done" }]);
    expect(bridge.asked.map((message) => [message.method, message.params])).toEqual([["elicitation/create", { mode: "form", message: "Leave this draft?", requestedSchema: { type: "object", properties: {} } }]]);
    expect(bridge.backend().find((entry) => "approval" in entry)!.approval).toEqual({ action: "accept", content: {} });
  });
});
