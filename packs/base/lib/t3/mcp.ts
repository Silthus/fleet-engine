import type { T3Deadline } from "./session.ts";

export class T3ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export type McpConnection = { callTool<T>(name: string, args: Record<string, unknown>): Promise<T> };

type ToolCallResponse = {
  result?: { content: { type: string; text?: string }[]; isError?: boolean };
  error?: { code: number; message: string };
};

const protocolVersion = "2025-06-18";

type McpResponse = { status: number; headers: Headers; text: string };

export async function openMcp(origin: string, token: string, timeoutMs: number, deadline: T3Deadline): Promise<McpConnection> {
  const post = async (what: string, body: unknown, headers: Record<string, string> = {}): Promise<McpResponse> => {
    const controller = new AbortController();
    const clear = deadline(what, timeoutMs, () => controller.abort(new Error(`no answer to ${what} within ${timeoutMs} ms`)));
    try {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    } catch (error) {
      throw new Error(`T3 did not answer at ${origin}/mcp: ${(error as Error).message}`);
    } finally { clear(); }
  };
  const initialized = await post("initialize", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "fleet", version: "1" } } });
  const sessionId = initialized.headers.get("mcp-session-id");
  if (initialized.status === 403) throw new Error("Linked environments is off on this machine. Turn it on in T3 Code's Settings → Labs.");
  if (initialized.status !== 200 || !sessionId) throw new Error(`T3 refused an MCP session (HTTP ${initialized.status})`);
  const sessionHeaders = { "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion };
  await post("notifications/initialized", { jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders);
  let nextId = 1;
  return {
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const response = await post(name, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, sessionHeaders);
      if (response.status !== 200) throw new Error(`T3 answered ${name} with HTTP ${response.status}`);
      const body = JSON.parse(responseJson(response.headers.get("content-type"), response.text)) as ToolCallResponse;
      if (body.error) throw new Error(body.error.message);
      const text = body.result?.content.map((part) => part.text ?? "").join("") ?? "";
      if (body.result?.isError) throw toolRefusal(text);
      return JSON.parse(text) as T;
    },
  };
}

function responseJson(contentType: string | null, text: string): string {
  if (!contentType?.includes("text/event-stream")) return text;
  return text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim()).join("");
}

function toolRefusal(text: string): T3ToolError {
  try {
    const refusal = JSON.parse(text) as { code?: string; message?: string };
    return new T3ToolError(refusal.code ?? "unknown", refusal.message || text);
  } catch { return new T3ToolError("unknown", text || "T3 refused the call"); }
}
