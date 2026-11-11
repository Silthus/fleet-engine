import { gatewayGroup, type Fetch } from "./client.ts";

const protocolVersion = "2025-06-18";

export type RouteReach = { gateway: { url: string; credential: string }; fetch: Fetch };
export type RouteAnswer = { text: string; structured?: unknown };
export type Route = { call(tool: string, args: Record<string, unknown>): Promise<RouteAnswer>; close(): Promise<void> };

export async function openRoute({ gateway, fetch }: RouteReach, route: string, client: string): Promise<Route> {
  const endpoint = `${gateway.url}/mcphub/mcp/${gatewayGroup}`;
  const base = { authorization: `Bearer ${gateway.credential}`, accept: "application/json, text/event-stream" };
  let session: Record<string, string> = {};
  const send = async (method: string, body?: Record<string, unknown>) => {
    const init = { method, headers: { ...base, ...session, ...(body && { "content-type": "application/json" }) }, ...(body && { body: JSON.stringify({ jsonrpc: "2.0", ...body }) }), signal: AbortSignal.timeout(120_000) };
    const response = await fetch(endpoint, init)
      .catch((error: Error) => { throw new Error(`Cannot reach the MCP gateway at ${gateway.url}: ${error.message}. On the hub, run: fleet mcp-gateway doctor`); });
    if (response.status === 401 || response.status === 403) throw new Error("The MCP gateway refused the hub's key. Run fleet apply on the hub.");
    if (!response.ok) throw new Error(`The MCP gateway answered ${body?.method ?? method} with HTTP ${response.status}.`);
    return response;
  };
  const opened = await send("POST", { id: 0, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: client, version: "1" } } });
  const id = opened.headers.get("mcp-session-id");
  session = { ...(id && { "mcp-session-id": id }), "mcp-protocol-version": protocolVersion };
  await opened.text();
  const close = async () => void (id && (await send("DELETE").then((response) => response.text(), () => undefined)));
  await send("POST", { method: "notifications/initialized" }).then((response) => response.text()).catch(async (error) => {
    await close();
    throw error;
  });
  let next = 1;
  return {
    async call(tool, args) {
      const body = (await jsonOf(await send("POST", { id: next++, method: "tools/call", params: { name: `${route}-${tool}`, arguments: args } }))) as {
        result?: { content?: { text?: string }[]; isError?: boolean; structuredContent?: unknown }; error?: { message: string };
      };
      if (body.error) throw new Error(`${route} ${tool}: ${body.error.message}`);
      const text = body.result?.content?.map((part) => part.text ?? "").join("") ?? "";
      if (body.result?.isError) throw new Error(`${route} ${tool}: ${text.slice(0, 300)}`);
      return { text, structured: body.result?.structuredContent };
    },
    close,
  };
}

async function jsonOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(text);
  const events = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice("data:".length)) as { id?: unknown });
  const answer = events.find((event) => event.id !== undefined);
  if (!answer) throw new Error("The MCP gateway ended its answer early.");
  return answer;
}
