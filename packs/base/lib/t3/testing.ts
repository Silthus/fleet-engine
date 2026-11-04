import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkedEnvironment } from "./environments.ts";
import type { ShellSnapshot, TurnItem } from "./threads.ts";

export type ToolHandler = (name: string, args: Record<string, unknown>) => unknown;

export type T3Fixture = {
  shell: ShellSnapshot;
  archived?: ShellSnapshot;
  turnItems?: Record<string, TurnItem[]>;
  links?: LinkedEnvironment[];
  tools?: ToolHandler;
};

export type T3Stub = {
  home: string;
  origin: string;
  cliCalls(): Promise<string[]>;
  rpcTags: string[];
  toolCalls: { name: string; args: Record<string, unknown> }[];
  stop(): Promise<void>;
};

export const shellToken = "shell-token";
export const mcpToken = "mcp-token";

const fakeCli = `[ $# -eq 0 ] && { read -r _; exit 0; }
echo "$*" >> "$(dirname "$0")/cli.log"
case "$*" in
  *"auth session issue"*mcp-client*) echo '{"sessionId":"mcp-session","token":"${mcpToken}"}' ;;
  *"auth session issue"*) echo 'issued {"sessionId":"shell-session","token":"${shellToken}"}' ;;
esac
`;

export class ToolRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function startT3Stub(fixture: T3Fixture): Promise<T3Stub> {
  const home = await mkdtemp(join(tmpdir(), "fleet-t3-"));
  const userdata = join(home, ".t3", "userdata");
  await mkdir(userdata, { recursive: true });
  const rpcTags: string[] = [];
  const toolCalls: T3Stub["toolCalls"] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      const bearer = request.headers.get("authorization");
      if (url.pathname === "/mcp") return bearer === `Bearer ${mcpToken}` ? mcp(request, fixture, toolCalls) : new Response(null, { status: 401 });
      if (bearer !== `Bearer ${shellToken}` || request.headers.get("x-t3-orchestration-protocol") !== "2") return new Response(null, { status: 401 });
      if (url.pathname === "/ws") return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
      if (url.pathname === "/api/orchestration/shell") return Response.json(fixture.shell);
      const bounded = url.pathname.match(/^\/api\/orchestration\/threads\/([^/]+)\/bounded$/);
      if (bounded) {
        const items = fixture.turnItems?.[decodeURIComponent(bounded[1]!)];
        return items ? Response.json({ projection: { visibleTurnItems: items }, historyCursor: null, hasMoreHistory: false }) : new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw));
        if (message._tag !== "Request") return;
        rpcTags.push(message.tag);
        const value = message.tag === "orchestration.getArchivedShellSnapshot" ? fixture.archived ?? { projects: [], threads: [] }
          : message.tag === "peerLinks.list" ? { links: fixture.links ?? [] } : undefined;
        const exit = value ? { _tag: "Success", value } : { _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "UnknownMethod" } } };
        socket.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit }));
      },
    },
  });
  const cli = join(home, "t3-server.js");
  await writeFile(cli, fakeCli);
  const serverProcess = Bun.spawn(["sh", cli], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  const origin = `http://127.0.0.1:${server.port}`;
  await writeFile(join(userdata, "server-runtime.json"), JSON.stringify({ pid: serverProcess.pid, origin }));
  return {
    home,
    origin,
    rpcTags,
    toolCalls,
    cliCalls: async () => (await readFile(join(home, "cli.log"), "utf8").catch(() => "")).split("\n").filter(Boolean),
    async stop() {
      serverProcess.kill();
      await server.stop(true);
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function mcp(request: Request, fixture: T3Fixture, toolCalls: T3Stub["toolCalls"]): Promise<Response> {
  const body = await request.json() as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
  if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "mcp-session-id": "mcp-stub-session" } });
  if (request.headers.get("mcp-session-id") !== "mcp-stub-session") return new Response(null, { status: 404 });
  if (body.method !== "tools/call") return new Response(null, { status: 202 });
  const { name, arguments: args } = body.params!;
  toolCalls.push({ name, args });
  try {
    const value = fixture.tools?.(name, args);
    if (value === undefined) throw new ToolRefusal("invalid_request", `no stub for ${name}`);
    return events({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
  } catch (error) {
    const code = error instanceof ToolRefusal ? error.code : "orchestration_error";
    return events({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message: (error as Error).message }) }] } });
  }
}

function events(message: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}
