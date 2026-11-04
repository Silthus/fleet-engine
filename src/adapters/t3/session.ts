import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { T3Rpc, T3Server } from "./port.ts";

type Runtime = { pid: number; origin: string };
type Cli = { command: string; args: string[] };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; stream: boolean };
type Message = { _tag?: string; requestId?: string; values?: unknown[]; exit?: { _tag: string; value?: unknown } };

const protocol = "2";
const timeoutMs = 30_000;
const scriptArg = /^(\/.*?\.[cm]?js)(?:\s|$)/;

function runtimeOf(home: string): Runtime | undefined {
  try {
    const runtime = JSON.parse(readFileSync(join(home, ".t3", "userdata", "server-runtime.json"), "utf8")) as Runtime;
    return Number.isInteger(runtime.pid) && typeof runtime.origin === "string" && alive(runtime.pid) ? runtime : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const scriptOf = (candidate: string) => scriptArg.exec(candidate)?.[1];

function serverCli(pid: number): Cli | undefined {
  try {
    if (process.platform === "linux") {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const script = scriptOf(argv[1] ?? "");
      return { command: readlinkSync(`/proc/${pid}/exe`), args: script ? [script] : [] };
    }
    const ps = (column: string) => Bun.spawnSync(["ps", "-p", String(pid), "-o", `${column}=`]).stdout.toString().trim();
    const command = ps("comm");
    const rest = ps("args").slice(command.length).trim();
    const bundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(command)?.[1];
    if (bundle) return { command, args: [`${bundle}/Contents/Resources/app.asar/apps/server/dist/bin.mjs`] };
    const script = scriptOf(rest);
    return command ? { command, args: script ? [script] : [] } : undefined;
  } catch {
    return undefined;
  }
}

function runCli(cli: Cli, argv: string[]) {
  const env = cli.args.length ? { ...Bun.env, ELECTRON_RUN_AS_NODE: "1" } : Bun.env;
  const result = Bun.spawnSync([cli.command, ...cli.args, ...argv], { env });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

function issueSession(cli: Cli) {
  const issued = runCli(cli, ["auth", "session", "issue", "--json", "--ttl", "5m", "--label", "fleet", "--subject", "fleet"]);
  if (issued.code !== 0) throw new Error("T3 Code did not issue a session");
  const session = JSON.parse(issued.stdout.slice(issued.stdout.indexOf("{"))) as { sessionId?: string; token?: string };
  if (!session.sessionId || !session.token) throw new Error("T3 Code issued an invalid session");
  return { sessionId: session.sessionId, token: session.token };
}

export async function connect(origin: string, token: string) {
  const url = new URL(origin);
  const headers = { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": protocol };
  const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new Socket(`${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/ws?orchestrationProtocol=${protocol}`, { headers });
  const pending = new Map<string, Pending>();
  const failAll = (reason: string) => {
    for (const call of pending.values()) call.reject(new Error(reason));
    pending.clear();
  };
  await new Promise<void>((resolve, reject) => {
    const fail = () => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.close();
      reject(new Error(`T3 Code did not answer at ${origin}`));
    };
    const timer = setTimeout(fail, timeoutMs);
    socket.onopen = () => (clearTimeout(timer), resolve());
    socket.onerror = fail;
  });
  socket.onerror = () => failAll("T3 Code connection failed");
  socket.onclose = () => failAll("T3 Code closed the connection");
  socket.onmessage = (event) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(String(event.data));
    } catch {
      return;
    }
    for (const message of (Array.isArray(decoded) ? decoded : [decoded]) as Message[]) {
      const id = String(message.requestId);
      const call = pending.get(id);
      if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
      if (message._tag === "Chunk") {
        socket.send(JSON.stringify({ _tag: "Ack", requestId: id }));
        if (call?.stream) {
          pending.delete(id);
          socket.send(JSON.stringify({ _tag: "Interrupt", requestId: id, interruptors: [] }));
          call.resolve(message.values?.[0]);
        }
      }
      if (message._tag === "Exit" && call) {
        pending.delete(id);
        if (message.exit?._tag === "Success") call.resolve(message.exit.value);
        else call.reject(new Error("T3 Code refused the request"));
      }
      if (message._tag === "Defect" || message._tag === "ClientProtocolError") failAll("T3 Code RPC protocol failed");
    }
  };
  let next = 1;
  const request = <T>(tag: string, payload: unknown, stream: boolean) =>
    new Promise<T>((resolve, reject) => {
      const id = String(next++);
      const timer = setTimeout(() => (pending.delete(id), reject(new Error(`T3 Code did not answer ${tag}`))), timeoutMs);
      pending.set(id, { stream, resolve: (value) => (clearTimeout(timer), resolve(value as T)), reject: (error) => (clearTimeout(timer), reject(error)) });
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  return { request, close: () => (failAll("T3 Code connection closed"), socket.close()) };
}

export const localT3Server: T3Server = {
  answering: async (home) => runtimeOf(home) !== undefined,
  async session(home, work) {
    const runtime = runtimeOf(home);
    if (!runtime) throw new Error("T3 Code is not running");
    const cli = serverCli(runtime.pid);
    if (!cli) throw new Error(`Fleet cannot find the command of T3 Code's server process ${runtime.pid}`);
    const session = issueSession(cli);
    let connection: ReturnType<typeof connect> | undefined;
    const socket = () => (connection ??= connect(runtime.origin, session.token));
    const rpc: T3Rpc = {
      call: async (tag, payload) => (await socket()).request(tag, payload, false),
      first: async (tag, payload) => (await socket()).request(tag, payload, true),
      async get<T>(path: string) {
        const response = await fetch(runtime.origin + path, { headers: { authorization: `Bearer ${session.token}`, "x-t3-orchestration-protocol": protocol }, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`T3 Code answered ${path} with ${response.status}`);
        return (await response.json()) as T;
      },
    };
    try {
      return await work(rpc);
    } finally {
      (await connection?.catch(() => undefined))?.close();
      runCli(cli, ["auth", "session", "revoke", session.sessionId]);
    }
  },
};
