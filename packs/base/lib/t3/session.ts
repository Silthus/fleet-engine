import { homedir } from "node:os";
import { openMcp, type McpConnection } from "./mcp.ts";
import { discoverT3Server, runT3Cli, t3AuthHeaders, t3CliFailure, type RunT3Cli, type T3Server } from "./server.ts";

export type T3Client = {
  getShell<T = unknown>(): Promise<T>;
  call<T = unknown>(tag: string, payload: unknown, timeoutMs?: number): Promise<T>;
};

export type T3HttpClient = T3Client & {
  get<T = unknown>(path: string): Promise<T>;
  callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
};

export type T3SessionOptions = {
  home?: string;
  server?: T3Server;
  ttl?: string;
  timeoutMs?: number;
  runCli?: RunT3Cli;
  deadline?: T3Deadline;
  access?: "read" | "write";
};

export type T3Deadline = (what: string, ms: number, expire: () => void) => () => void;

const realDeadline: T3Deadline = (_what, ms, expire) => {
  const timer = setTimeout(expire, ms);
  return () => clearTimeout(timer);
};

type IssuedSession = { sessionId: string; token: string };
type PendingCall = { resolve(value: unknown): void; reject(error: Error): void };

const defaultTimeoutMs = 30_000;
const sessionLabel = "fleet";
const readScopes = ["--scope", "orchestration:read", "--scope", "access:read"];

export async function readT3Settings<T>(client: Pick<T3Client, "call">): Promise<T> {
  return (await client.call<{ settings: T }>("server.getConfig", {})).settings;
}

class T3Rpc {
  private nextId = 1;
  private pending = new Map<string, PendingCall>();

  private constructor(private socket: WebSocket, private timeoutMs: number, private deadline: T3Deadline) {
    socket.onmessage = (event) => this.receive(String(event.data));
    socket.onclose = () => this.rejectPending("T3 closed the connection");
    socket.onerror = () => this.rejectPending("T3 connection failed");
  }

  static async connect(server: T3Server, token: string, timeoutMs: number, deadline: T3Deadline): Promise<T3Rpc> {
    const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    const socket = new Socket(server.wsUrl, { headers: t3AuthHeaders(token) });
    const rpc = new T3Rpc(socket, timeoutMs, deadline);
    await new Promise<void>((resolve, reject) => {
      const clearTimer = deadline(`connecting to ${server.origin}`, timeoutMs, () => {
        socket.close();
        reject(new Error(`T3 did not answer at ${server.origin}`));
      });
      socket.onopen = () => {
        clearTimer();
        socket.onerror = () => rpc.rejectPending("T3 connection failed");
        socket.onclose = () => rpc.rejectPending("T3 closed the connection");
        resolve();
      };
      socket.onerror = () => { clearTimer(); reject(new Error(`T3 did not answer at ${server.origin}`)); };
      socket.onclose = () => { clearTimer(); reject(new Error(`T3 closed the connection at ${server.origin}`)); };
    });
    return rpc;
  }

  call<T>(tag: string, payload: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const clearTimer = this.deadline(tag, timeoutMs, () => {
        this.pending.delete(id);
        reject(new Error(`T3 did not answer ${tag} within ${timeoutMs} ms`));
      });
      this.pending.set(id, {
        resolve(value) { clearTimer(); resolve(value as T); },
        reject(error) { clearTimer(); reject(error); },
      });
      try { this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] })); }
      catch {
        this.pending.delete(id);
        clearTimer();
        reject(new Error(`T3 RPC ${tag} could not send`));
      }
    });
  }

  close(): void {
    this.rejectPending("T3 connection closed");
    this.socket.close();
  }

  private receive(raw: string): void {
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { return; }
    for (const value of Array.isArray(decoded) ? decoded : [decoded]) {
      if (!value || typeof value !== "object") continue;
      const message = value as { _tag?: string; requestId?: string; exit?: { _tag: string; value?: unknown } };
      if (message._tag === "Ping") this.socket.send(JSON.stringify({ _tag: "Pong" }));
      if (message._tag === "Chunk") this.socket.send(JSON.stringify({ _tag: "Ack", requestId: String(message.requestId) }));
      if (message._tag === "Exit") {
        const pending = this.pending.get(String(message.requestId));
        this.pending.delete(String(message.requestId));
        if (message.exit?._tag === "Success") pending?.resolve(message.exit.value);
        else pending?.reject(new Error("T3 RPC request failed"));
      }
      if (message._tag === "Defect" || message._tag === "ClientProtocolError") this.rejectPending("T3 RPC protocol failed");
    }
  }

  private rejectPending(message: string): void {
    for (const call of this.pending.values()) call.reject(new Error(message));
    this.pending.clear();
  }
}

function issueSession(server: T3Server, runCli: RunT3Cli, args: string[]): IssuedSession {
  const issued = runCli(server, ["auth", "session", "issue", "--json", ...args]);
  if (issued.status !== 0) throw new Error(`T3 auth session issue failed: ${t3CliFailure(issued)}`);
  try {
    const session = JSON.parse(issued.stdout.slice(issued.stdout.indexOf("{"))) as IssuedSession;
    if (!session.sessionId || !session.token) throw new Error();
    return session;
  } catch { throw new Error("T3 auth session response is invalid"); }
}

export async function withT3Session<T>(run: (client: T3HttpClient) => Promise<T>, options: T3SessionOptions = {}): Promise<T> {
  const server = options.server ?? discoverT3Server(options.home ?? homedir());
  const runCli = options.runCli ?? runT3Cli;
  const deadline = options.deadline ?? realDeadline;
  const ttl = options.ttl ?? "5m";
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const session = issueSession(server, runCli, ["--ttl", ttl, "--label", sessionLabel, "--subject", sessionLabel, ...(options.access === "write" ? [] : readScopes)]);
  const issued = [session];
  let rpc: Promise<T3Rpc> | undefined;
  let mcp: Promise<McpConnection> | undefined;
  const get = async <R>(path: string): Promise<R> => {
    const controller = new AbortController();
    const clear = deadline(path, timeoutMs, () => controller.abort(new Error(`no answer to ${path} within ${timeoutMs} ms`)));
    try {
      const response = await fetch(server.origin + path, { headers: t3AuthHeaders(session.token), signal: controller.signal })
        .catch((error: Error) => { throw new Error(`T3 did not answer at ${server.origin}: ${error.message}`); });
      if (!response.ok) throw new Error(`T3 ${path} returned ${response.status}`);
      return await response.json() as R;
    } finally { clear(); }
  };
  const outcome = await Promise.resolve().then(() => run({
    get,
    getShell: <R>() => get<R>("/api/orchestration/shell"),
    async call<R>(tag: string, payload: unknown, callTimeoutMs?: number) {
      rpc ??= T3Rpc.connect(server, session.token, timeoutMs, deadline);
      return (await rpc).call<R>(tag, payload, callTimeoutMs);
    },
    async callTool<R>(name: string, args: Record<string, unknown>) {
      mcp ??= Promise.resolve().then(() => {
        const reader = issueSession(server, runCli, ["--ttl", ttl, "--label", sessionLabel, "--subject", "mcp-client", "--scope", "orchestration:read"]);
        issued.push(reader);
        return openMcp(server.origin, reader.token, timeoutMs, deadline);
      });
      return (await mcp).callTool<R>(name, args);
    },
  })).then((value) => ({ value }), (error: unknown) => ({ error }));
  if (rpc) (await rpc.catch(() => undefined))?.close();
  await mcp?.catch(() => undefined);
  const revokeFailure = revokeEach(server, runCli, issued);
  if ("error" in outcome) {
    if (revokeFailure && outcome.error instanceof Error) outcome.error.message += `; ${revokeFailure}`;
    throw outcome.error;
  }
  if (revokeFailure) throw new Error(revokeFailure);
  return outcome.value;
}

function revokeEach(server: T3Server, runCli: RunT3Cli, sessions: IssuedSession[]): string | undefined {
  const failures = sessions.flatMap(({ sessionId }) => {
    const revoked = runCli(server, ["auth", "session", "revoke", sessionId]);
    return revoked.status === 0 ? [] : [`${sessionId} ${t3CliFailure(revoked)}`];
  });
  return failures.length ? `T3 auth session revoke failed: ${failures.join("; ")}` : undefined;
}
