import { Database } from "bun:sqlite";
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
  resolutions?: Resolution[];
  links?: LinkedEnvironment[];
  tools?: ToolHandler;
  rpc?: (tag: string, payload: unknown) => unknown;
  environmentId?: string;
};

export type T3Stub = {
  home: string;
  origin: string;
  cliCalls(): Promise<string[]>;
  rpcTags: string[];
  rpcCalls: { tag: string; payload: unknown }[];
  toolCalls: { name: string; args: Record<string, unknown> }[];
  stop(): Promise<void>;
};

export const shellToken = "shell-token";
export const mcpToken = "mcp-token";

const runningLine = "t3-stub-running";

const fakeCli = `[ $# -eq 0 ] && { echo ${runningLine}; read -r _; exit 0; }
echo "$*" >> "$(dirname "$0")/cli.log"
case "$*" in
  *"auth session issue"*mcp-client*) echo '{"sessionId":"mcp-session","token":"${mcpToken}"}' ;;
  *"auth session issue"*) echo 'issued {"sessionId":"shell-session","token":"${shellToken}"}' ;;
esac
`;

export type Resolution = { thread: string; request: string; command: string | null };

export function writeT3EventStore(path: string, resolutions: Resolution[]) {
  const db = new Database(path);
  db.run(`create table orchestration_events (sequence integer primary key autoincrement, aggregate_kind text not null, stream_id text not null,
    event_type text not null, command_id text, payload_json text not null)`);
  for (const { thread, request, command } of resolutions) {
    db.run("insert into orchestration_events (aggregate_kind, stream_id, event_type, command_id, payload_json) values ('thread', ?, 'runtime-request.updated', null, ?)", [thread, JSON.stringify({ id: request, status: "pending" })]);
    db.run("insert into orchestration_events (aggregate_kind, stream_id, event_type, command_id, payload_json) values ('thread', ?, 'runtime-request.updated', ?, ?)", [thread, command, JSON.stringify({ id: request, status: "resolved", answers: { "0": "yes" } })]);
  }
  db.close();
  return path;
}

export class ToolRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function startT3Stub(fixture: T3Fixture): Promise<T3Stub> {
  const home = await mkdtemp(join(tmpdir(), "fleet-t3-"));
  const userdata = join(home, ".t3", "userdata");
  await mkdir(userdata, { recursive: true });
  if (fixture.resolutions) writeT3EventStore(join(userdata, "statev2.sqlite"), fixture.resolutions);
  const rpcTags: string[] = [];
  const rpcCalls: T3Stub["rpcCalls"] = [];
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
      if (url.pathname === "/.well-known/t3/environment" && fixture.environmentId) return Response.json({ environmentId: fixture.environmentId });
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
        rpcCalls.push({ tag: message.tag, payload: message.payload });
        const value = message.tag === "orchestration.getArchivedShellSnapshot" ? fixture.archived ?? { projects: [], threads: [] }
          : message.tag === "peerLinks.list" ? { links: fixture.links ?? [] } : fixture.rpc?.(message.tag, message.payload);
        const exit = value ? { _tag: "Success", value } : { _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "UnknownMethod" } } };
        socket.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit }));
      },
    },
  });
  const cli = join(home, "t3-server.js");
  await writeFile(cli, fakeCli);
  const serverProcess = Bun.spawn(["sh", cli], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  await untilRunning(serverProcess.stdout);
  const origin = `http://127.0.0.1:${server.port}`;
  await writeFile(join(userdata, "server-runtime.json"), JSON.stringify({ pid: serverProcess.pid, origin }));
  return {
    home,
    origin,
    rpcTags,
    rpcCalls,
    toolCalls,
    cliCalls: async () => (await readFile(join(home, "cli.log"), "utf8").catch(() => "")).split("\n").filter(Boolean),
    async stop() {
      serverProcess.kill();
      await server.stop(true);
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function untilRunning(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes(runningLine)) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The T3 stub server ended before it ran");
    seen += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
}

async function mcp(request: Request, fixture: T3Fixture, toolCalls: T3Stub["toolCalls"]): Promise<Response> {
  const body = await request.json() as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
  if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "mcp-session-id": "mcp-stub-session" } });
  if (request.headers.get("mcp-session-id") !== "mcp-stub-session") return new Response(null, { status: 404 });
  if (body.method !== "tools/call") return new Response(null, { status: 202 });
  const { name, arguments: args } = body.params!;
  toolCalls.push({ name, args });
  try {
    checkToolArguments(name, args);
    const value = fixture.tools?.(name, args);
    if (value === undefined) throw new ToolRefusal("invalid_request", `no stub for ${name}`);
    return events({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
  } catch (error) {
    const code = error instanceof ToolRefusal ? error.code : "orchestration_error";
    return events({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message: (error as Error).message }) }] } });
  }
}

type ArgumentRule = (value: unknown) => boolean;

const isString: ArgumentRule = (value) => typeof value === "string" && value.length > 0;
const isBoolean: ArgumentRule = (value) => typeof value === "boolean";
const nonNegativeInt: ArgumentRule = (value) => Number.isInteger(value) && (value as number) >= 0;
const positiveInt: ArgumentRule = (value) => Number.isInteger(value) && (value as number) >= 1;
const pageLimit: ArgumentRule = (value) => positiveInt(value) && (value as number) <= 100;

const toolContracts: Record<string, { required: string[]; rules: Record<string, ArgumentRule> }> = {
  t3_thread_list: {
    required: [],
    rules: {
      environmentId: isString, projectId: isString, allProjects: isBoolean, statuses: Array.isArray, titleContains: isString,
      settled: isBoolean, snoozed: isBoolean, includeSubagents: isBoolean, cursor: nonNegativeInt, limit: pageLimit,
    },
  },
  t3_thread_read: {
    required: ["threadId"],
    rules: {
      environmentId: isString, threadId: isString, itemId: isString, textOffset: nonNegativeInt,
      view: (value) => value === "messages" || value === "activity", afterPosition: nonNegativeInt,
      limit: positiveInt, runLimit: positiveInt, maxCharsPerItem: positiveInt,
    },
  },
  t3_project_list: { required: [], rules: { environmentId: isString, cursor: nonNegativeInt, limit: pageLimit } },
};

function checkToolArguments(name: string, args: Record<string, unknown>): void {
  const contract = toolContracts[name];
  if (!contract) return;
  const missing = contract.required.find((key) => args[key] === undefined);
  if (missing) throw new ToolRefusal("invalid_request", `Invalid ${name} arguments: ${missing} is required`);
  for (const [key, value] of Object.entries(args)) {
    const rule = contract.rules[key];
    if (!rule) throw new ToolRefusal("invalid_request", `Invalid ${name} arguments: unknown ${key}`);
    if (!rule(value)) throw new ToolRefusal("invalid_request", `Invalid ${name} arguments: ${key} ${JSON.stringify(value)}`);
  }
}

function events(message: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}
