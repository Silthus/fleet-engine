import { gatewayEndpoint, grantHint, type Fetch, type GatewayClient } from "./client.ts";

export type BridgeOptions = { client: GatewayClient; stdin: ReadableStream<Uint8Array>; write: (line: string) => void; fail: (line: string) => void; fetch: Fetch };

type Message = { id?: string | number | null; method?: string; result?: { protocolVersion?: unknown } };

export async function bridge({ client, stdin, write, fail, fetch }: BridgeOptions): Promise<number> {
  const endpoint = gatewayEndpoint(client);
  const closing = new AbortController();
  const reader = stdin.getReader();
  let session: string | undefined;
  let protocol: string | undefined;
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

  const headers = (body: boolean): Record<string, string> => ({
    authorization: `Bearer ${client.token}`,
    accept: "application/json, text/event-stream",
    ...(body ? { "content-type": "application/json" } : {}),
    ...(session ? { "mcp-session-id": session } : {}),
    ...(protocol ? { "mcp-protocol-version": protocol } : {}),
  });

  async function call(method: "POST" | "GET", body?: string) {
    let response: Response;
    try { response = await fetch(endpoint, { method, headers: headers(body !== undefined), body, signal: closing.signal }); }
    catch { return stop(`Cannot reach the MCP gateway at ${client.baseUrl}. On the hub, run: fleet mcphub doctor`), undefined; }
    if (response.status === 401 || response.status === 403) return stop(`The MCP gateway refused this machine's key. ${grantHint}`), undefined;
    return response;
  }

  function deliver(text: string) {
    let message: Message;
    try { message = JSON.parse(text); } catch { return; }
    if (typeof message.result?.protocolVersion === "string" && !protocol) protocol = message.result.protocolVersion;
    write(JSON.stringify(message));
  }

  function relay(response: Response) {
    const type = response.headers.get("content-type") ?? "";
    const done = type.includes("text/event-stream")
      ? (async () => { for await (const data of events(response.body!)) deliver(data); })()
      : type.includes("application/json")
        ? response.json().then((body: unknown) => { for (const message of [body].flat()) deliver(JSON.stringify(message)); })
        : response.body?.cancel();
    Promise.resolve(done).catch(() => {});
  }

  async function send(line: string) {
    let message: Message;
    try { message = JSON.parse(line); }
    catch { return write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); }
    const response = await call("POST", line);
    if (!response) return;
    if (message.method === "initialize") session = response.headers.get("mcp-session-id") ?? undefined;
    if (!response.ok) {
      await response.body?.cancel();
      if (message.method !== undefined && message.id !== undefined) write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `The MCP gateway answered HTTP ${response.status}.` } }));
      return;
    }
    relay(response);
    if (message.method === "notifications/initialized") await listen();
  }

  async function listen() {
    const response = await call("GET");
    if (response?.ok) relay(response);
    else await response?.body?.cancel();
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
        if (line) await send(line);
        if (closing.signal.aborted) return 1;
      }
    }
    if (closing.signal.aborted) return 1;
    if (session) await fetch(endpoint, { method: "DELETE", headers: headers(false), signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    closing.abort();
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
