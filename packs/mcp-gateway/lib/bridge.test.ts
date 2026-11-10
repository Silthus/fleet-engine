import { afterEach, expect, test } from "bun:test";
import { bridge, lineWriter } from "./bridge.ts";

type Message = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };
type Seen = { method: string; message?: Message; session: string | null; protocol: string | null };
type Handler = (message: Message, request: Request) => Response | Promise<Response>;

const token = "mcphub_secret-token";
const encoder = new TextEncoder();
const servers: Array<{ stop(force: boolean): unknown }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function sse(...messages: Message[]) {
  return messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join("");
}

function never<T>() {
  return new Promise<T>(() => {});
}

function fakeGateway(handlers: Record<string, Handler> = {}, listen?: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const watchers: Array<{ match: (item: Seen) => boolean; resolve: () => void }> = [];
  let answerElicitation: (message: Message) => void = () => {};
  let sessions = 0;
  let current: string | undefined;
  let refuseInitialize = false;
  const record = (item: Seen) => {
    seen.push(item);
    for (const watcher of watchers.filter((entry) => entry.match(item))) watchers.splice(watchers.indexOf(watcher), 1), watcher.resolve();
  };
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/mcphub/mcp/fleet") return new Response(null, { status: 404 });
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
      const session = request.headers.get("mcp-session-id");
      const protocol = request.headers.get("mcp-protocol-version");
      if (request.method === "DELETE") return record({ method: "DELETE", session, protocol }), new Response(null, { status: 200 });
      if (session !== null && session !== current) {
        record({ method: request.method === "GET" ? "GET" : `stale ${((await request.json()) as Message).method ?? "response"}`, session, protocol });
        return new Response("Session not found", { status: 404 });
      }
      if (request.method === "GET") {
        record({ method: "GET", session, protocol });
        if (listen) return listen();
        const listChanged: Message = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
        return new Response(new ReadableStream({ start: (controller) => controller.enqueue(encoder.encode(`: open\n\n${sse(listChanged)}`)) }), { headers: { "content-type": "text/event-stream" } });
      }
      const body = (await request.json()) as Message | Message[];
      if (Array.isArray(body)) return record({ method: "batch", session, protocol }), handlers.batch!(body as unknown as Message, request);
      const message = body;
      if (session === null && message.method !== "initialize") return record({ method: `sessionless ${message.method ?? "response"}`, session, protocol }), new Response("No valid session ID", { status: 400 });
      record({ method: message.method ?? "response", message, session, protocol });
      if (message.method === "initialize") {
        if (refuseInitialize) return new Response("starting", { status: 503 });
        current = `session-${++sessions}`;
        return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mcphub", version: "1.1.0" } } }, { headers: { "mcp-session-id": current } });
      }
      if (message.id === undefined || message.method === undefined) {
        if (message.id === "ask-1") answerElicitation(message);
        return new Response(null, { status: 202 });
      }
      const handler = handlers[message.method];
      if (handler) return handler(message, request);
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
  return {
    seen,
    baseUrl: `http://127.0.0.1:${server.port}/mcphub`,
    saw(method: string) {
      return seen.some((item) => item.method === method) ? Promise.resolve() : new Promise<void>((resolve) => watchers.push({ match: (item) => item.method === method, resolve }));
    },
    restart(options: { refuseInitialize?: boolean } = {}) { current = undefined; refuseInitialize = options.refuseInitialize ?? false; },
  };
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
    send: (message: Message | Message[]) => input.enqueue(encoder.encode(`${JSON.stringify(message)}\n`)),
    sendRaw: (text: string) => input.enqueue(encoder.encode(text)),
    close: () => input.close(),
    next(match: (message: Message) => boolean) {
      const found = received.find(match);
      return found ? Promise.resolve(found) : new Promise<Message>((resolve) => waiting.push({ match, resolve }));
    },
  };
}

const initialize: Message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude", version: "1" } } };
const initialized: Message = { jsonrpc: "2.0", method: "notifications/initialized" };

async function connected(gateway: ReturnType<typeof fakeGateway>, fetcher: typeof fetch = fetch) {
  const client = stdioClient();
  const done = bridge({ client: { baseUrl: gateway.baseUrl, token }, stdin: client.stdin, write: client.write, fail: client.fail, fetch: fetcher });
  client.send(initialize);
  await client.next((message) => message.id === 1);
  client.send(initialized);
  return { client, done };
}

test("relays initialize, a tool call with its elicitation, and notifications both ways, then ends the session", async () => {
  const gateway = fakeGateway();
  const client = stdioClient();
  const done = bridge({ client: { baseUrl: gateway.baseUrl, token }, stdin: client.stdin, write: client.write, fail: client.fail, fetch });
  client.send(initialize);
  expect((await client.next((message) => message.id === 1)).result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "mcphub" } });
  client.sendRaw(`${JSON.stringify(initialized)}\n{"jsonrpc":"2.0","id":2,"method":"tools/call",`);
  client.sendRaw(`"params":{"name":"calendar-list-events","arguments":{}}}\n`);
  expect(await client.next((message) => message.method === "notifications/tools/list_changed")).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  const asked = await client.next((message) => message.method === "elicitation/create");
  client.send({ jsonrpc: "2.0", id: asked.id!, result: { action: "accept", content: {} } });
  expect((await client.next((message) => message.id === 2)).result).toEqual({ content: [{ type: "text", text: "answered accept" }] });
  client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
  await gateway.saw("notifications/cancelled");
  client.close();
  expect(await done).toBe(0);
  expect(client.errors).toEqual([]);
  const order = gateway.seen.map((item) => item.method);
  expect(order.filter((method) => method !== "GET")).toEqual(["initialize", "notifications/initialized", "tools/call", "response", "notifications/cancelled", "DELETE"]);
  expect(order.indexOf("GET")).toBeGreaterThan(order.indexOf("notifications/initialized"));
  expect(gateway.seen.slice(1).every((item) => item.session === "session-1" && item.protocol === "2025-06-18")).toBe(true);
  expect(gateway.seen[0]).toMatchObject({ session: null, protocol: null });
});

test("sends an elicitation answer while the tool call still waits for its headers", async () => {
  let ask!: (message: Message) => void;
  let gatewayAnswer: (message: Message) => void = () => {};
  const asking = new Promise<Message>((resolve) => { ask = resolve; });
  const gateway = fakeGateway({
    "tools/call": async (message) => {
      ask({ jsonrpc: "2.0", id: "ask-1", method: "elicitation/create", params: { message: "Send it?" } });
      const answer = await new Promise<Message>((resolve) => { gatewayAnswer = resolve; });
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `answered ${String(answer.result?.action)}` }] } });
    },
  }, async () => {
    const message = await asking;
    return new Response(new ReadableStream({ start: (controller) => controller.enqueue(encoder.encode(sse(message))) }), { headers: { "content-type": "text/event-stream" } });
  });
  const { client, done } = await connected(gateway);
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "calendar-create", arguments: {} } });
  const asked = await client.next((message) => message.method === "elicitation/create");
  await gateway.saw("tools/call");
  const watching = gateway.saw("response").then(() => gatewayAnswer(gateway.seen.find((item) => item.method === "response")!.message!));
  client.send({ jsonrpc: "2.0", id: asked.id!, result: { action: "accept" } });
  await watching;
  expect((await client.next((message) => message.id === 2)).result).toEqual({ content: [{ type: "text", text: "answered accept" }] });
  client.close();
  expect(await done).toBe(0);
});

test("a pending GET stream does not delay tools/list", async () => {
  const gateway = fakeGateway({ "tools/list": (message) => Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }) }, () => never());
  const { client, done } = await connected(gateway);
  await gateway.saw("GET");
  client.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  expect(await client.next((message) => message.id === 3)).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: [] } });
  client.close();
  expect(await done).toBe(0);
});

function intercepting(method: string, answer: (init: RequestInit, message: Message) => Promise<Response>) {
  let started!: () => void;
  const reached = new Promise<void>((resolve) => { started = resolve; });
  const fetcher = Object.assign(async (input: string | URL | Request, init: RequestInit = {}) => {
    const message = typeof init.body === "string" ? (JSON.parse(init.body) as Message) : undefined;
    if (message?.method !== method) return fetch(input, init);
    started();
    return answer(init, message);
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  return { fetcher, reached };
}

test("closing stdin aborts a pending POST, ends the session, and exits", async () => {
  const gateway = fakeGateway();
  const aborted: string[] = [];
  const slow = intercepting("tools/call", (init, message) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => {
    aborted.push(String(message.id));
    reject(new DOMException("aborted", "AbortError"));
  })));
  const { client, done } = await connected(gateway, slow.fetcher);
  client.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "slow", arguments: {} } });
  await slow.reached;
  client.close();
  expect(await done).toBe(0);
  expect(aborted).toEqual(["4"]);
  expect(gateway.seen.at(-1)).toMatchObject({ method: "DELETE", session: "session-1" });
  expect(client.errors).toEqual([]);
  expect(client.received.filter((message) => message.id === 4)).toEqual([]);
});

test("answers each request of a POST whose event stream fails before it answers, without the key or the address", async () => {
  const gateway = fakeGateway();
  const flaky = intercepting("tools/call", async () => {
    let pulled = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (pulled++ === 0) controller.enqueue(encoder.encode(sse({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })));
        else controller.error(new Error(`socket closed ${token} ${gateway.baseUrl}?token=x`));
      },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  const { client, done } = await connected(gateway, flaky.fetcher);
  client.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "flaky", arguments: {} } });
  const answer = await client.next((message) => message.id === 5);
  expect(answer).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32603, message: "The MCP gateway ended its answer early." } });
  expect(client.received.find((message) => message.method === "notifications/progress")).toBeDefined();
  expect(JSON.stringify(client.received)).not.toContain(token);
  expect(JSON.stringify(client.received)).not.toContain("127.0.0.1");
  client.close();
  expect(await done).toBe(0);
});

test("answers a request whose JSON body is broken", async () => {
  const gateway = fakeGateway({ "tools/call": () => new Response("{not json", { headers: { "content-type": "application/json" } }) });
  const { client, done } = await connected(gateway);
  client.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "broken", arguments: {} } });
  expect(await client.next((message) => message.id === 6)).toEqual({ jsonrpc: "2.0", id: 6, error: { code: -32603, message: "The MCP gateway ended its answer early." } });
  client.close();
  expect(await done).toBe(0);
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

test("answers each request in a batch the gateway fails, and skips its notifications", async () => {
  const gateway = fakeGateway({ batch: () => new Response("upstream broke", { status: 502 }) });
  const { client, done } = await connected(gateway);
  client.send([{ jsonrpc: "2.0", id: 7, method: "tools/list" }, { jsonrpc: "2.0", method: "notifications/progress" }, { jsonrpc: "2.0", id: "eight", method: "prompts/list" }]);
  await client.next((message) => message.id === "eight");
  expect(client.received.filter((message) => message.error)).toEqual([
    { jsonrpc: "2.0", id: 7, error: { code: -32603, message: "The MCP gateway answered HTTP 502." } },
    { jsonrpc: "2.0", id: "eight", error: { code: -32603, message: "The MCP gateway answered HTTP 502." } },
  ]);
  client.close();
  expect(await done).toBe(0);
});

test("starts a new session after MCPHub restarts, retries the request once, and hides the replayed initialize", async () => {
  const gateway = fakeGateway({ "tools/list": (message) => Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }) });
  const { client, done } = await connected(gateway);
  await gateway.saw("notifications/initialized");
  gateway.restart();
  client.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  expect(await client.next((message) => message.id === 9)).toEqual({ jsonrpc: "2.0", id: 9, result: { tools: [] } });
  expect(client.received.filter((message) => message.id === 1)).toHaveLength(1);
  const posts = gateway.seen.filter((item) => item.method !== "GET");
  expect(posts.map((item) => [item.method, item.session])).toEqual([
    ["initialize", null], ["notifications/initialized", "session-1"], ["stale tools/list", "session-1"],
    ["initialize", null], ["notifications/initialized", "session-2"], ["tools/list", "session-2"],
  ]);
  client.close();
  expect(await done).toBe(0);
  expect(client.errors).toEqual([]);
});

test("holds a request sent while a new session starts, then sends it with the new session", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let initializes = 0;
  const renewal = intercepting("initialize", async (init) => {
    if (++initializes === 2) release();
    if (initializes === 2) await new Promise<void>((resolve) => { resume = resolve; });
    return fetch(`${gateway.baseUrl}/mcp/fleet`, init);
  });
  let resume: () => void = () => {};
  const gateway = fakeGateway({ "tools/list": (message) => Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }) });
  const { client, done } = await connected(gateway, renewal.fetcher);
  await gateway.saw("notifications/initialized");
  gateway.restart();
  client.send({ jsonrpc: "2.0", id: 12, method: "tools/list" });
  await held;
  client.send({ jsonrpc: "2.0", id: 13, method: "tools/list" });
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve));
  resume();
  const answers = await Promise.all([12, 13].map((id) => client.next((message) => message.id === id)));
  expect(answers.map((message) => message.result)).toEqual([{ tools: [] }, { tools: [] }]);
  expect(gateway.seen.filter((item) => item.method === "tools/list").map((item) => item.session)).toEqual(["session-2", "session-2"]);
  client.close();
  expect(await done).toBe(0);
});

test("exits with one line that says what to do when MCPHub restarts and refuses a new session", async () => {
  const gateway = fakeGateway();
  const { client, done } = await connected(gateway);
  await gateway.saw("notifications/initialized");
  gateway.restart({ refuseInitialize: true });
  client.send({ jsonrpc: "2.0", id: 10, method: "tools/list" });
  expect(await done).toBe(1);
  expect(client.errors).toEqual(["The MCP gateway lost this session and could not start a new one. Restart this MCP server, and on the hub, run: fleet mcp-gateway doctor"]);
  expect(client.received.filter((message) => message.id === 10)).toEqual([]);
});

test("stops reading a response stream until a full stdout drains", async () => {
  let pulls = 0;
  const notes = [1, 2, 3].map((progress): Message => ({ jsonrpc: "2.0", method: "notifications/progress", params: { progress } }));
  const answers = async (_input: string | URL | Request, init: RequestInit = {}) => {
    if (init.method !== "POST") return new Response(null, { status: 200 });
    const message = JSON.parse(String(init.body)) as Message;
    if (message.method === "initialize") return (Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "mcp-session-id": "session-1" } }));
    return new Response(new ReadableStream({ pull(controller) { const note = notes[pulls++]; if (note) controller.enqueue(encoder.encode(sse(note))); else controller.close(); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  };
  const lines: string[] = [];
  let drain: () => void = () => {};
  const stdout = { write: (chunk: string) => (lines.push(chunk), false), once: (_event: "drain", listener: () => void) => { drain = listener; } };
  const client = stdioClient();
  const done = bridge({ client: { baseUrl: "http://127.0.0.1:3317/mcphub", token }, stdin: client.stdin, write: lineWriter(stdout), fail: client.fail, fetch: Object.assign(answers, { preconnect: fetch.preconnect }) as typeof fetch });
  client.send(initialize);
  for (let tick = 0; tick < 20 && lines.length === 0; tick++) await Promise.resolve();
  drain();
  client.send({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "chatty", arguments: {} } });
  for (let tick = 0; tick < 50 && lines.length < 2; tick++) await new Promise((resolve) => setImmediate(resolve));
  expect(lines).toHaveLength(2);
  for (let tick = 0; tick < 50; tick++) await new Promise((resolve) => setImmediate(resolve));
  expect(lines).toHaveLength(2);
  expect(pulls).toBe(1);
  drain();
  for (let tick = 0; tick < 50 && lines.length < 3; tick++) await new Promise((resolve) => setImmediate(resolve));
  expect(lines[2]).toBe(`${JSON.stringify(notes[1])}\n`);
  client.close();
  drain();
  expect(await done).toBe(0);
});

test("the line writer waits for drain only when the stream reports it is full", async () => {
  let full = false;
  let drain: () => void = () => {};
  const stream = { write: () => !full, once: (_event: "drain", listener: () => void) => { drain = listener; } };
  const write = lineWriter(stream);
  expect(write("a")).toBeUndefined();
  full = true;
  let drained = false;
  const waiting = Promise.resolve(write("b")).then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  drain();
  await waiting;
  expect(drained).toBe(true);
});

test("stops with one plain line, without the key, when the gateway refuses it", async () => {
  const gateway = fakeGateway();
  const client = stdioClient();
  const done = bridge({ client: { baseUrl: gateway.baseUrl, token: "mcphub_revoked-token" }, stdin: client.stdin, write: client.write, fail: client.fail, fetch });
  client.send(initialize);
  expect(await done).toBe(1);
  expect(client.errors).toEqual(["The MCP gateway refused this machine's key. On the hub, run: fleet mcp-gateway grant <this machine's SSH name>"]);
  expect(client.received).toEqual([]);
});

test("stops with one plain line, without the key, when the gateway is unreachable", async () => {
  const client = stdioClient();
  const unreachable = async () => { throw new TypeError(`Unable to connect. Is the computer able to access the url? Bearer ${token}`); };
  const done = bridge({ client: { baseUrl: "http://127.0.0.1:3317/mcphub", token }, stdin: client.stdin, write: client.write, fail: client.fail, fetch: unreachable });
  client.send(initialize);
  expect(await done).toBe(1);
  expect(client.errors).toEqual(["Cannot reach the MCP gateway at http://127.0.0.1:3317/mcphub. On the hub, run: fleet mcp-gateway doctor"]);
  expect(client.errors.join("\n")).not.toContain(token);
});

test("drops an answer to a question the old session asked, so it never reaches the new session", async () => {
  const gateway = fakeGateway({ "tools/list": (message) => Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }) });
  const { client, done } = await connected(gateway);
  client.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send", arguments: {} } });
  const asked = await client.next((message) => message.method === "elicitation/create");
  gateway.restart();
  client.send({ jsonrpc: "2.0", id: asked.id!, result: { action: "accept" } });
  client.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  await client.next((message) => message.id === 9);
  expect(gateway.seen.filter((item) => item.session === "session-2").map((item) => item.method)).not.toContain("response");
  client.close();
  expect(await done).toBe(0);
  expect(client.errors).toEqual([]);
});

test("a failing stream of the old session does not stop the new one", async () => {
  let failOld!: () => void;
  let gets = 0;
  const gateway = fakeGateway({ "tools/list": (message) => Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }) });
  const fetcher = Object.assign(async (input: string | URL | Request, init: RequestInit = {}) => {
    if (init.method !== "GET" || ++gets > 1) return fetch(input, init);
    return new Promise<Response>((_, reject) => { failOld = () => reject(new TypeError("connection reset")); });
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  const { client, done } = await connected(gateway, fetcher);
  await gateway.saw("notifications/initialized");
  gateway.restart();
  client.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  await client.next((message) => message.id === 9);
  failOld();
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve));
  client.send({ jsonrpc: "2.0", id: 11, method: "tools/list" });
  expect(await client.next((message) => message.id === 11)).toEqual({ jsonrpc: "2.0", id: 11, result: { tools: [] } });
  client.close();
  expect(await done).toBe(0);
  expect(client.errors).toEqual([]);
});

test("an answer to the old session's question never answers the new session's question with the same id", async () => {
  const gateway = fakeGateway();
  const { client, done } = await connected(gateway);
  client.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send", arguments: {} } });
  const old = await client.next((message) => message.method === "elicitation/create");
  gateway.restart();
  client.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "send", arguments: {} } });
  const fresh = await client.next((message) => message.method === "elicitation/create" && message.id !== old.id);
  client.send({ jsonrpc: "2.0", id: old.id!, result: { action: "accept" } });
  client.send({ jsonrpc: "2.0", id: fresh.id!, result: { action: "decline" } });
  expect((await client.next((message) => message.id === 4)).result).toEqual({ content: [{ type: "text", text: "answered decline" }] });
  const answers = gateway.seen.filter((item) => item.method === "response");
  expect(answers.map((item) => [item.session, item.message?.id, item.message?.result?.action])).toEqual([["session-2", "ask-1", "decline"]]);
  client.close();
  expect(await done).toBe(0);
});

test("a question that arrives late on a POST of the old session is dropped, and its answer still reaches the client", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const gateway = fakeGateway({ "tools/list": (message) => Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }) });
  const late = intercepting("tools/call", async (_, message) => {
    await held;
    const late: Message = { jsonrpc: "2.0", id: "late-1", method: "elicitation/create", params: { message: "Late?" } };
    return new Response(sse(late, { jsonrpc: "2.0", id: message.id, result: { content: [] } }), { headers: { "content-type": "text/event-stream" } });
  });
  const { client, done } = await connected(gateway, late.fetcher);
  await gateway.saw("notifications/initialized");
  client.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "slow", arguments: {} } });
  await late.reached;
  gateway.restart();
  client.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  await client.next((message) => message.id === 9);
  release();
  expect((await client.next((message) => message.id === 5)).result).toEqual({ content: [] });
  expect(client.received.filter((message) => message.method === "elicitation/create")).toEqual([]);
  client.close();
  expect(await done).toBe(0);
});

test("the old session's stream failing while the new session starts does not stop the bridge", async () => {
  let failOld!: () => void;
  let gets = 0;
  let initializes = 0;
  const gateway = fakeGateway({ "tools/list": (message) => Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }) });
  const fetcher = Object.assign(async (input: string | URL | Request, init: RequestInit = {}) => {
    if (init.method === "GET" && ++gets === 1) return new Promise<Response>((_, reject) => { failOld = () => reject(new TypeError("connection reset")); });
    const message = typeof init.body === "string" ? (JSON.parse(init.body) as Message) : undefined;
    if (message?.method === "initialize" && ++initializes === 2) {
      failOld();
      for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve));
    }
    return fetch(input, init);
  }, { preconnect: fetch.preconnect }) as typeof fetch;
  const { client, done } = await connected(gateway, fetcher);
  await gateway.saw("notifications/initialized");
  gateway.restart();
  client.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  expect(await client.next((message) => message.id === 9)).toEqual({ jsonrpc: "2.0", id: 9, result: { tools: [] } });
  client.close();
  expect(await done).toBe(0);
  expect(client.errors).toEqual([]);
});

test("a cancelled gateway question reaches the client with the bridge id, and its later answer is dropped", async () => {
  let cancel!: () => void;
  const gateway = fakeGateway({}, () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse({ jsonrpc: "2.0", id: "ask-0", method: "elicitation/create", params: { message: "Send it?" } })));
      cancel = () => controller.enqueue(encoder.encode(sse({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "ask-0", reason: "gone" } }, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "unknown" } })));
    },
  }), { headers: { "content-type": "text/event-stream" } }));
  const { client, done } = await connected(gateway);
  const asked = await client.next((message) => message.method === "elicitation/create");
  cancel();
  const cancelled = await client.next((message) => message.method === "notifications/cancelled");
  expect(cancelled.params).toEqual({ requestId: asked.id, reason: "gone" });
  client.send({ jsonrpc: "2.0", id: asked.id!, result: { action: "accept" } });
  client.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99 } });
  await gateway.saw("notifications/cancelled");
  expect(client.received.filter((message) => message.method === "notifications/cancelled")).toHaveLength(1);
  expect(gateway.seen.map((item) => item.method)).not.toContain("response");
  client.close();
  expect(await done).toBe(0);
});
