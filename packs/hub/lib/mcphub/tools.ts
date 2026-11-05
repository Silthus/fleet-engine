import { events } from "./bridge.ts";
import { gatewayEndpoint, grantHint, type Fetch, type GatewayClient } from "./client.ts";

export type GatewayTools = {
  list(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
};

type Answer = { id?: number; result?: Record<string, unknown>; error?: { message?: string } };

const toolTimeoutMs = 120_000;

export async function openGatewayTools(client: GatewayClient, fetch: Fetch): Promise<GatewayTools> {
  const endpoint = gatewayEndpoint(client);
  let session: string | undefined;
  let nextId = 1;
  const headers = () => ({
    authorization: `Bearer ${client.token}`, accept: "application/json, text/event-stream", "content-type": "application/json",
    ...(session ? { "mcp-session-id": session } : {}),
  });

  async function send(method: string, params: Record<string, unknown>, notify = false): Promise<Answer["result"]> {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", method, params, ...(notify ? {} : { id }) });
    const response = await fetch(endpoint, { method: "POST", headers: headers(), body, signal: AbortSignal.timeout(toolTimeoutMs) })
      .catch(() => { throw new Error(`Cannot reach the MCP gateway at ${client.baseUrl}. On the hub, run: fleet mcphub doctor`); });
    if (response.status === 401 || response.status === 403) throw new Error(`The MCP gateway refused this machine's key. ${grantHint}`);
    if (!response.ok) throw new Error(`The MCP gateway answered ${method} with HTTP ${response.status}.`);
    session ??= response.headers.get("mcp-session-id") ?? undefined;
    if (notify) return void (await response.body?.cancel());
    const answer = await answerTo(response, id);
    if (answer?.error) throw new Error(`The MCP gateway refused ${method}: ${answer.error.message ?? "no reason"}`);
    if (!answer?.result) throw new Error(`The MCP gateway ended its answer to ${method} early.`);
    return answer.result;
  }

  await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fleet", version: "1" } });
  await send("notifications/initialized", {}, true);

  return {
    async list() {
      const names: string[] = [];
      let cursor: unknown;
      do {
        const page = (await send("tools/list", cursor ? { cursor } : {}))!;
        names.push(...((page.tools as Array<{ name: string }> | undefined) ?? []).map((tool) => tool.name));
        cursor = page.nextCursor;
      } while (typeof cursor === "string" && cursor);
      return names;
    },
    async call(name, args) {
      const result = (await send("tools/call", { name, arguments: args }))!;
      const text = ((result.content as Array<{ text?: string }> | undefined) ?? []).map((part) => part.text ?? "").join("\n");
      if (result.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
      return text;
    },
    async close() {
      if (session) await fetch(endpoint, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    },
  };
}

function matching(text: string, id: number): Answer | undefined {
  try { return [JSON.parse(text) as Answer | Answer[]].flat().find((message) => message.id === id); }
  catch { return undefined; }
}

async function answerTo(response: Response, id: number): Promise<Answer | undefined> {
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return matching(await response.text(), id);
  for await (const data of events(response.body!)) {
    const answer = matching(data, id);
    if (answer) return answer;
  }
  return undefined;
}
