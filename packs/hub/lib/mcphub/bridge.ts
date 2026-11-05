import { gatewayEndpoint, grantHint, type Fetch, type GatewayClient } from "./client.ts";

export type Write = (line: string) => void | Promise<void>;
export type BridgeOptions = { client: GatewayClient; stdin: ReadableStream<Uint8Array>; write: Write; fail: (line: string) => void; fetch: Fetch };

type Id = string | number;
type Message = { id?: Id | null; method?: string; result?: { protocolVersion?: unknown } };

const endedEarly = "The MCP gateway ended its answer early.";
const lostSession = "The MCP gateway lost this session and could not start a new one. Restart this MCP server, and on the hub, run: fleet mcphub doctor";

export function lineWriter(stream: { write(chunk: string): boolean; once(event: "drain", listener: () => void): unknown }): Write {
  return (line) => {
    if (stream.write(`${line}\n`)) return;
    return new Promise<void>((resolve) => { stream.once("drain", resolve); });
  };
}

const requestIds = (messages: Message[]) => messages.flatMap((message) => (message.method !== undefined && message.id !== undefined && message.id !== null ? [message.id] : []));
const background = (work: Promise<unknown>) => { work.catch(() => {}); };

export async function bridge({ client, stdin, write, fail, fetch }: BridgeOptions): Promise<number> {
  const endpoint = gatewayEndpoint(client);
  const closing = new AbortController();
  const reader = stdin.getReader();
  let session: string | undefined;
  let protocol: string | undefined;
  let handshake: string[] = [];
  let ready: Promise<unknown> = Promise.resolve();
  let renewing: Promise<boolean> = Promise.resolve(true);
  let stop!: (line: string) => void;
  const stopped = new Promise<number>((resolve) => {
    stop = (line) => {
      if (closing.signal.aborted) return;
      fail(line);
      closing.abort();
      reader.cancel().catch(() => {});
      resolve(1);
    };
  });

  const headers = (body: boolean, initializing = false): Record<string, string> => ({
    authorization: `Bearer ${client.token}`,
    accept: "application/json, text/event-stream",
    ...(body ? { "content-type": "application/json" } : {}),
    ...(session && !initializing ? { "mcp-session-id": session } : {}),
    ...(protocol && !initializing ? { "mcp-protocol-version": protocol } : {}),
  });

  async function call(method: "POST" | "GET", body?: string, initializing = false) {
    let response: Response;
    try { response = await fetch(endpoint, { method, headers: headers(body !== undefined, initializing), body, signal: closing.signal }); }
    catch { return stop(`Cannot reach the MCP gateway at ${client.baseUrl}. On the hub, run: fleet mcphub doctor`), undefined; }
    if (response.status === 401 || response.status === 403) return stop(`The MCP gateway refused this machine's key. ${grantHint}`), undefined;
    return response;
  }

  async function answerLeft(waiting: Set<Id>, reason: string) {
    if (closing.signal.aborted) return;
    for (const id of waiting) await write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: reason } }));
  }

  async function deliver(text: string, waiting: Set<Id>) {
    let parsed: Message | Message[];
    try { parsed = JSON.parse(text); } catch { return; }
    for (const message of [parsed].flat()) {
      if (typeof message.result?.protocolVersion === "string" && !protocol) protocol = message.result.protocolVersion;
      if (message.method === undefined && message.id !== undefined && message.id !== null) waiting.delete(message.id);
      await write(JSON.stringify(message));
    }
  }

  async function relay(response: Response, waiting: Set<Id>) {
    const type = response.headers.get("content-type") ?? "";
    try {
      if (type.includes("text/event-stream")) { for await (const data of events(response.body!)) await deliver(data, waiting); }
      else if (type.includes("application/json")) await deliver(await response.text(), waiting);
      else await response.body?.cancel();
    } catch {}
    await answerLeft(waiting, endedEarly);
  }

  async function listen() {
    const response = await call("GET");
    if (response?.ok) await relay(response, new Set());
    else await response?.body?.cancel();
  }

  async function replay(line: string, initializing: boolean) {
    const response = await fetch(endpoint, { method: "POST", headers: headers(true, initializing), body: line, signal: closing.signal }).catch(() => undefined);
    await response?.body?.cancel().catch(() => {});
    return response?.ok ? response : undefined;
  }

  async function startSession() {
    const [initialize, ...rest] = handshake;
    const fresh = initialize ? (await replay(initialize, true))?.headers.get("mcp-session-id") : undefined;
    if (!fresh) return false;
    session = fresh;
    for (const line of rest) if (!(await replay(line, false))) return false;
    background(listen());
    return true;
  }

  function renew(stale: string) {
    if (session === stale) {
      session = undefined;
      renewing = startSession().then((started) => started || (stop(lostSession), false));
    }
    return renewing;
  }

  async function post(line: string, messages: Message[], retried = false): Promise<void> {
    if (!(await renewing)) return;
    const sentWith = session;
    const initializing = messages.some((message) => message.method === "initialize");
    const response = await call("POST", line, initializing);
    if (!response) return;
    if (response.status === 404 && sentWith && !retried && !initializing) {
      await response.body?.cancel();
      if (await renew(sentWith)) return post(line, messages, true);
      return;
    }
    const waiting = new Set(requestIds(messages));
    if (!response.ok) {
      await response.body?.cancel();
      return answerLeft(waiting, `The MCP gateway answered HTTP ${response.status}.`);
    }
    if (initializing) session = response.headers.get("mcp-session-id") ?? undefined, handshake = [line];
    if (messages.some((message) => message.method === "notifications/initialized")) handshake.push(line), background(listen());
    background(relay(response, waiting));
  }

  function dispatch(line: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { return background(Promise.resolve(write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })))); }
    const messages = [parsed].flat() as Message[];
    const sent = ready.then(() => post(line, messages));
    background(sent);
    if (messages.some((message) => message.method === "initialize" || message.method === "notifications/initialized")) ready = sent.catch(() => {});
  }

  async function pump() {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done || closing.signal.aborted) break;
      buffer += decoder.decode(value, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) dispatch(line);
      }
    }
    if (closing.signal.aborted) return 1;
    closing.abort();
    if (session) await fetch(endpoint, { method: "DELETE", headers: headers(false), signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    return 0;
  }

  return Promise.race([pump(), stopped]);
}

async function* events(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const lines = buffer.slice(0, end).split("\n");
      buffer = buffer.slice(end + 2);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (data && (!event || event === "message")) yield data;
    }
  }
}
