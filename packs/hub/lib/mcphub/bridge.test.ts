import { afterEach, expect, test } from "bun:test";
import { bridge } from "./bridge.ts";

type Message = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };
type Seen = { method: string; message?: Message; session: string | null; protocol: string | null };

const token = "mcphub_secret-token";
const encoder = new TextEncoder();
const servers: Array<{ stop(force: boolean): unknown }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function sse(...messages: Message[]) {
  return messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join("");
}

function fakeGateway() {
  const seen: Seen[] = [];
  let answerElicitation: (message: Message) => void = () => {};
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/mcphub/mcp/fleet") return new Response(null, { status: 404 });
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
      const session = request.headers.get("mcp-session-id");
      const protocol = request.headers.get("mcp-protocol-version");
      if (request.method === "DELETE") return seen.push({ method: "DELETE", session, protocol }), new Response(null, { status: 200 });
      if (request.method === "GET") {
        seen.push({ method: "GET", session, protocol });
        const listChanged: Message = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
        return new Response(new ReadableStream({ start: (controller) => controller.enqueue(encoder.encode(`: open\n\n${sse(listChanged)}`)) }), { headers: { "content-type": "text/event-stream" } });
      }
      const message = (await request.json()) as Message;
      seen.push({ method: message.method ?? "response", message, session, protocol });
      if (message.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mcphub", version: "1.1.0" } } }, { headers: { "mcp-session-id": "session-1" } });
      }
      if (message.id === undefined || message.method === undefined) {
        if (message.id === "ask-1") answerElicitation(message);
        return new Response(null, { status: 202 });
      }
      if (message.method === "tools/list") return new Response("upstream broke", { status: 500 });
      const answered = new Promise<Message>((resolve) => { answerElicitation = resolve; });
      const elicitation: Message = { jsonrpc: "2.0", id: "ask-1", method: "elicitation/create", params: { message: "Send it?", requestedSchema: { type: "object", properties: {} } } };
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(sse(elicitation)));
          const answer = await answered;
          controller.enqueue(encoder.encode(sse({ jsonrpc: "2.0", id: message.id!, result: { content: [{ type: "text", text: `answered ${String(answer.result?.action)}` }] } })));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  servers.push(server);
  return { seen, baseUrl: `http://127.0.0.1:${server.port}/mcphub` };
}

function stdioClient() {
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const stdin = new ReadableStream<Uint8Array>({ start: (controller) => { input = controller; } });
  const received: Message[] = [];
  const errors: string[] = [];
  const waiting: Array<{ match: (message: Message) => boolean; resolve: (message: Message) => void }> = [];
  return {
    stdin,
    received,
    errors,
    write(line: string) {
      const message = JSON.parse(line) as Message;
      received.push(message);
      for (const waiter of waiting.filter((item) => item.match(message))) waiting.splice(waiting.indexOf(waiter), 1), waiter.resolve(message);
    },
    fail: (line: string) => { errors.push(line); },
    send: (message: Message) => input.enqueue(encoder.encode(`${JSON.stringify(message)}\n`)),
    sendRaw: (text: string) => input.enqueue(encoder.encode(text)),
    close: () => input.close(),
    next(match: (message: Message) => boolean) {
      const found = received.find(match);
      return found ? Promise.resolve(found) : new Promise<Message>((resolve) => waiting.push({ match, resolve }));
    },
  };
}

const initialize: Message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude", version: "1" } } };

test("relays initialize, a tool call with its elicitation, and notifications both ways, then ends the session", async () => {
  const gateway = fakeGateway();
  const client = stdioClient();
  const done = bridge({ client: { baseUrl: gateway.baseUrl, token }, stdin: client.stdin, write: client.write, fail: client.fail, fetch });
  client.send(initialize);
  expect((await client.next((message) => message.id === 1)).result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "mcphub" } });
  client.sendRaw(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n{"jsonrpc":"2.0","id":2,"method":"tools/call",`);
  client.sendRaw(`"params":{"name":"calendar-list-events","arguments":{}}}\n`);
  expect(await client.next((message) => message.method === "notifications/tools/list_changed")).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  const asked = await client.next((message) => message.method === "elicitation/create");
  client.send({ jsonrpc: "2.0", id: asked.id!, result: { action: "accept", content: {} } });
  expect((await client.next((message) => message.id === 2)).result).toEqual({ content: [{ type: "text", text: "answered accept" }] });
  client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
  client.close();
  expect(await done).toBe(0);
  expect(client.errors).toEqual([]);
  expect(gateway.seen.map((item) => item.method)).toEqual(["initialize", "notifications/initialized", "GET", "tools/call", "response", "notifications/cancelled", "DELETE"]);
  expect(gateway.seen.slice(1).every((item) => item.session === "session-1" && item.protocol === "2025-06-18")).toBe(true);
  expect(gateway.seen[0]).toMatchObject({ session: null, protocol: null });
});

test("answers a request the gateway fails with a JSON-RPC error and keeps relaying", async () => {
  const gateway = fakeGateway();
  const client = stdioClient();
  const done = bridge({ client: { baseUrl: gateway.baseUrl, token }, stdin: client.stdin, write: client.write, fail: client.fail, fetch });
  client.send(initialize);
  await client.next((message) => message.id === 1);
  client.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  expect(await client.next((message) => message.id === 3)).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32603, message: "The MCP gateway answered HTTP 500." } });
  client.close();
  expect(await done).toBe(0);
});

test("stops with one plain line, without the key, when the gateway refuses it", async () => {
  const gateway = fakeGateway();
  const client = stdioClient();
  const done = bridge({ client: { baseUrl: gateway.baseUrl, token: "mcphub_revoked-token" }, stdin: client.stdin, write: client.write, fail: client.fail, fetch });
  client.send(initialize);
  expect(await done).toBe(1);
  expect(client.errors).toEqual(["The MCP gateway refused this machine's key. On the hub, run: fleet mcphub grant <this machine's SSH name>"]);
  expect(client.received).toEqual([]);
});

test("stops with one plain line, without the key, when the gateway is unreachable", async () => {
  const client = stdioClient();
  const unreachable = async () => { throw new TypeError(`Unable to connect. Is the computer able to access the url? Bearer ${token}`); };
  const done = bridge({ client: { baseUrl: "http://127.0.0.1:3317/mcphub", token }, stdin: client.stdin, write: client.write, fail: client.fail, fetch: unreachable });
  client.send(initialize);
  expect(await done).toBe(1);
  expect(client.errors).toEqual(["Cannot reach the MCP gateway at http://127.0.0.1:3317/mcphub. On the hub, run: fleet mcphub doctor"]);
  expect(client.errors.join("\n")).not.toContain(token);
});
