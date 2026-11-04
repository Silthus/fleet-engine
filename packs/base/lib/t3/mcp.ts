export type McpConnection = { callTool<T>(name: string, args: Record<string, unknown>): Promise<T> };

type ToolCallResponse = {
  result?: { content: { type: string; text?: string }[]; isError?: boolean };
  error?: { code: number; message: string };
};

const protocolVersion = "2025-06-18";

export async function openMcp(origin: string, token: string, timeoutMs: number): Promise<McpConnection> {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error: Error) => { throw new Error(`T3 did not answer at ${origin}/mcp: ${error.message}`); });
  const initialized = await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "fleet", version: "1" } } });
  const sessionId = initialized.headers.get("mcp-session-id");
  if (initialized.status === 403) throw new Error("Linked environments is off on this machine. Turn it on in T3 Code's Settings → Labs.");
  if (initialized.status !== 200 || !sessionId) throw new Error(`T3 refused an MCP session (HTTP ${initialized.status})`);
  const sessionHeaders = { "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion };
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders);
  let nextId = 1;
  return {
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const response = await post({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, sessionHeaders);
      if (response.status !== 200) throw new Error(`T3 answered ${name} with HTTP ${response.status}`);
      const body = JSON.parse(responseJson(response.headers.get("content-type"), await response.text())) as ToolCallResponse;
      if (body.error) throw new Error(body.error.message);
      const text = body.result?.content.map((part) => part.text ?? "").join("") ?? "";
      if (body.result?.isError) throw new Error(refusalMessage(text));
      return JSON.parse(text) as T;
    },
  };
}

function responseJson(contentType: string | null, text: string): string {
  if (!contentType?.includes("text/event-stream")) return text;
  return text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim()).join("");
}

function refusalMessage(text: string): string {
  try {
    const refusal = JSON.parse(text) as { message?: string };
    return refusal.message || text;
  } catch { return text || "T3 refused the call"; }
}
