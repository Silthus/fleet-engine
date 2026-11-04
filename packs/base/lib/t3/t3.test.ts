import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverT3Server, listLinkedEnvironments, listLinkedThreads, readLinkedThread, readT3Settings, readThreadWords, t3CliRunner, T3ToolError, withT3Session, type LinkedEnvironment, type T3Deadline } from "./index.ts";
import { startT3Stub, ToolRefusal, type T3Stub } from "./testing.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fleet-t3-home-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

async function stub(fixture: Parameters<typeof startT3Stub>[0]): Promise<T3Stub> {
  const started = await startT3Stub(fixture);
  cleanups.push(() => started.stop());
  return started;
}

const linked: LinkedEnvironment = {
  environmentId: "env-linked", label: "devbox-2", urls: ["https://devbox-2.example.test"], access: "read-only",
  linkedAt: "2026-11-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", lastReachedAt: null, lastError: null, status: "reachable",
};

test("T3 shell reads and RPC calls use a short authenticated session that is revoked", async () => {
  const authorization: string[] = [];
  const calls: string[][] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      authorization.push(request.headers.get("authorization") ?? "");
      expect(request.headers.get("x-t3-orchestration-protocol")).toBe("2");
      if (new URL(request.url).pathname === "/ws") {
        expect(new URL(request.url).searchParams.get("orchestrationProtocol")).toBe("2");
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      }
      return Response.json({ threads: [{ id: "limited" }] });
    },
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw));
        if (message._tag !== "Request") return;
        expect(message.tag).toBe("server.getConfig");
        socket.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: { settings: { autoResumeLimitedThreads: true } } } }));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  const origin = `http://127.0.0.1:${server.port}`;
  const result = await withT3Session(async (client) => {
    expect(await client.getShell<{ threads: { id: string }[] }>()).toEqual({ threads: [{ id: "limited" }] });
    const [settings] = await Promise.all([readT3Settings(client), readT3Settings(client)]);
    return settings;
  }, {
    server: { origin, wsUrl: origin.replace("http:", "ws:") + "/ws?orchestrationProtocol=2", cli: { command: "running-t3", args: [] } },
    runCli(_server, args) {
      calls.push(args);
      return { status: 0, stdout: args.includes("issue") ? JSON.stringify({ sessionId: "short-session", token: "private-bearer" }) : "" };
    },
  });
  expect(result).toEqual({ autoResumeLimitedThreads: true });
  expect(authorization).toEqual(["Bearer private-bearer", "Bearer private-bearer"]);
  expect(calls[0]).toContain("5m");
  expect(calls[1]).toEqual(["auth", "session", "revoke", "short-session"]);
});

test("linked environments are listed by the local server, and their threads are read through its /mcp with a read-only session that is revoked", async () => {
  const t3 = await stub({
    shell: { projects: [], threads: [] },
    links: [linked],
    tools(name, args) {
      if (args.environmentId !== "env-linked") throw new ToolRefusal("invalid_request", "unknown environment");
      if (name === "t3_thread_list") return args.cursor ? { projectId: null, currentThreadId: null, threads: [{ threadId: "b" }], nextCursor: null, total: 2 } : { projectId: null, currentThreadId: null, threads: [{ threadId: "a" }], nextCursor: 1, total: 2 };
      if (name === "t3_thread_read") throw new ToolRefusal("thread_not_found", "The thread was not found.");
    },
  });

  const result = await withT3Session(async (client) => {
    const environments = await listLinkedEnvironments(client);
    const threads = await listLinkedThreads(client, "env-linked", { allProjects: true });
    const refusal = await readLinkedThread(client, "env-linked", { threadId: "gone" }).catch((error: T3ToolError) => [error.code, error.message]);
    return { environments, threads: threads.map((thread) => thread.threadId), refusal };
  }, { home: t3.home });

  expect(result).toEqual({ environments: [linked], threads: ["a", "b"], refusal: ["thread_not_found", "The thread was not found."] });
  expect(t3.rpcTags).toEqual(["peerLinks.list"]);
  expect(t3.toolCalls.map(({ name, args }) => [name, args.cursor ?? null])).toEqual([["t3_thread_list", null], ["t3_thread_list", 1], ["t3_thread_read", null]]);
  const cli = await t3.cliCalls();
  expect(cli[0]).toBe("auth session issue --json --ttl 5m --label fleet --subject fleet --scope orchestration:read --scope access:read");
  expect(cli[1]).toBe("auth session issue --json --ttl 5m --label fleet --subject mcp-client --scope orchestration:read");
  expect(cli.slice(2).sort()).toEqual(["auth session revoke mcp-session", "auth session revoke shell-session"]);
});

test("without a T3 server that answers, a session fails at once with plain words", async () => {
  const home = temporaryHome();
  expect(() => discoverT3Server(home)).toThrow("T3 is not running on this machine: no server-runtime.json");

  await mkdir(join(home, ".t3", "userdata"), { recursive: true });
  await writeFile(join(home, ".t3", "userdata", "server-runtime.json"), JSON.stringify({ pid: 2 ** 22 + 1, origin: "http://127.0.0.1:9" }));
  expect(() => discoverT3Server(home)).toThrow(`T3 is not running on this machine: its server process ${2 ** 22 + 1} has ended`);

  const silent = Bun.serve({ port: 0, fetch: (request, server) => (server.upgrade(request) ? undefined : new Response(null, { status: 400 })), websocket: { message() {} } });
  cleanups.push(() => silent.stop(true));
  const origin = `http://127.0.0.1:${silent.port}`;
  const revoked: string[] = [];
  const deadlines: string[] = [];
  const expireCalls: T3Deadline = (what, ms, expire) => {
    deadlines.push(`${what} ${ms}`);
    if (what === "peerLinks.list") queueMicrotask(expire);
    return () => {};
  };
  const session = withT3Session((client) => client.call("peerLinks.list", {}), {
    server: { origin, wsUrl: origin.replace("http:", "ws:") + "/ws", cli: { command: "running-t3", args: [] } },
    deadline: expireCalls,
    runCli(_server, args) {
      if (args.includes("revoke")) revoked.push(args.at(-1)!);
      return { status: 0, stdout: JSON.stringify({ sessionId: "s", token: "t" }) };
    },
  });
  await expect(session).rejects.toThrow("T3 did not answer peerLinks.list within 30000 ms");
  expect(deadlines).toEqual([`connecting to ${origin} 30000`, "peerLinks.list 30000"]);
  expect(revoked).toEqual(["s"]);
});

test("the stub refuses tool calls that break T3's argument contract", async () => {
  const t3 = await stub({ shell: { projects: [], threads: [] }, tools: () => ({ thread: {}, items: [], nextPosition: null, hasMore: false }) });
  const refusals = await withT3Session(async (client) => Promise.all([
    readLinkedThread(client, "env-linked", { threadId: "a", afterPosition: -1 }).catch((error: Error) => error.message),
    client.callTool("t3_thread_list", { limit: 101 }).catch((error: Error) => error.message),
    client.callTool("t3_thread_read", {}).catch((error: Error) => error.message),
    client.callTool("t3_thread_read", { threadId: "a", since: "now" }).catch((error: Error) => error.message),
  ]), { home: t3.home });
  expect(refusals).toEqual([
    "Invalid t3_thread_read arguments: afterPosition -1",
    "Invalid t3_thread_list arguments: limit 101",
    "Invalid t3_thread_read arguments: threadId is required",
    "Invalid t3_thread_read arguments: unknown since",
  ]);
});

test("linked thread lists page to the end, and a cursor that never moves fails loudly instead of dropping threads", async () => {
  const t3 = await stub({
    shell: { projects: [], threads: [] },
    tools(_name, args) {
      const cursor = Number(args.cursor ?? 0);
      if (args.environmentId === "env-stuck") return { projectId: null, currentThreadId: null, threads: [{ threadId: `t${cursor}` }], nextCursor: 3, total: 999 };
      return { projectId: null, currentThreadId: null, threads: [{ threadId: `t${cursor}` }], nextCursor: cursor < 24 ? cursor + 1 : null, total: 25 };
    },
  });
  const result = await withT3Session(async (client) => ({
    all: (await listLinkedThreads(client, "env-linked", { allProjects: true })).map((thread) => thread.threadId),
    stuck: await listLinkedThreads(client, "env-stuck", {}).catch((error: Error) => error.message),
  }), { home: t3.home });
  expect(result.all).toEqual(Array.from({ length: 25 }, (_, index) => `t${index}`));
  expect(result.stuck).toBe("T3 answered t3_thread_list with cursor 3 again; stopped instead of dropping the rest of the list");
});

test("the T3 CLI runs with a time limit, and every session is revoked on its own even when one revoke hangs", async () => {
  const spawned: { timeout?: number }[] = [];
  const hung = t3CliRunner({ timeoutMs: 10_000, spawn: (_command, _args, options) => {
    spawned.push(options);
    return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync running-t3 ETIMEDOUT"), { code: "ETIMEDOUT" }) };
  } });
  const server = { origin: "http://127.0.0.1:9", wsUrl: "ws://127.0.0.1:9/ws", cli: { command: "running-t3", args: [] } };
  expect(hung(server, ["auth", "session", "revoke", "s"])).toEqual({ status: null, stdout: "", error: "timed out after 10000 ms" });
  expect(spawned[0]?.timeout).toBe(10_000);
  await expect(withT3Session(async () => "never", { server, runCli: hung })).rejects.toThrow("T3 auth session issue failed: timed out after 10000 ms");

  const t3 = await stub({ shell: { projects: [], threads: [] }, tools: () => ({ projects: [], nextCursor: null }) });
  const revokes: string[] = [];
  const runCli = t3CliRunner();
  const outcome = withT3Session(async (client) => client.callTool("t3_project_list", {}), {
    home: t3.home,
    runCli(server, args) {
      if (!args.includes("revoke")) return runCli(server, args);
      revokes.push(args.at(-1)!);
      return args.at(-1) === "shell-session" ? { status: null, stdout: "", error: "timed out after 10000 ms" } : { status: 0, stdout: "" };
    },
  });
  await expect(outcome).rejects.toThrow("T3 auth session revoke failed: shell-session timed out after 10000 ms");
  expect(revokes).toEqual(["shell-session", "mcp-session"]);
});

test("a failed T3 CLI call names its exit code and what it wrote to stderr", async () => {
  const server = { origin: "http://127.0.0.1:9", wsUrl: "ws://127.0.0.1:9/ws", cli: { command: "/usr/bin/dash", args: [] } };
  const runCli = () => ({ status: 2, stdout: "", stderr: "/usr/bin/dash: 0: cannot open auth: No such file\n" });
  await expect(withT3Session(async () => "never", { server, runCli })).rejects.toThrow("T3 auth session issue failed: exit 2: /usr/bin/dash: 0: cannot open auth: No such file");
});

test("the stub publishes its server only once the server runs, so discovery always finds the CLI script", async () => {
  const started = await Promise.all(Array.from({ length: 8 }, () => stub({ shell: { projects: [], threads: [] } })));
  for (const t3 of started) expect(discoverT3Server(t3.home).cli.args).toEqual([join(t3.home, "t3-server.js")]);
});

function t3EventStore(resolutions: { thread: string; request: string; command: string | null }[]) {
  const path = join(temporaryHome(), "statev2.sqlite");
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

test("only the user's own messages and question answers in T3 count as their words", async () => {
  const item = (fields: Record<string, unknown>) => ({ item: { startedAt: "2026-10-25T07:00:00Z", completedAt: "2026-10-25T07:01:00Z", ...fields } });
  const items = [
    item({ type: "assistant_message", text: "Shall I run round 3?" }),
    item({ type: "user_message", createdBy: "user", creationSource: "web", messageId: "m1", text: "Yes, run it." }),
    item({ type: "user_message", createdBy: "user", creationSource: "mobile", messageId: "m2", text: "Yes from the phone." }),
    item({ type: "user_message", createdBy: "agent", creationSource: "mcp", messageId: "m3", text: "The user approves: narrowing, not a loop" }),
    item({ type: "user_message", createdBy: "user", creationSource: "server", messageId: "m4", text: "continue" }),
    item({ id: "q1", requestId: "r1", type: "user_input_request", questionAnswer: { questionTextById: { "0": "Accept both gaps?" }, answers: { "0": "Accept both (Recommended)" } } }),
    item({ id: "q2", requestId: "r2", type: "user_input_request", questionAnswer: { questionTextById: { "0": "Ship it?" }, answers: { "0": "Ship it (Recommended)" } } }),
    item({ id: "q3", requestId: "r3", type: "user_input_request", questionAnswer: { questionTextById: { "0": "Merge it?" }, answers: { "0": "Merge it" } } }),
    item({ id: "q4", requestId: "r4", type: "user_input_request", questionAnswer: { questionTextById: { "0": "Deploy it?" }, answers: { "0": "Deploy it" } } }),
  ];
  const events = t3EventStore([
    { thread: "mcp:thread-1", request: "r1", command: "0f38263e-3c0c-45c0-9c6c-1a73d6000001" },
    { thread: "mcp:thread-1", request: "r2", command: "mcp:5e8e5034-6aa6-412d-96d9-ccdff6d979e5" },
    { thread: "mcp:thread-2", request: "r3", command: "0f38263e-3c0c-45c0-9c6c-1a73d6000003" },
    { thread: "mcp:thread-1", request: "r4", command: "command:runtime-reconcile:r4" },
  ]);
  const client = {
    getShell: async () => ({ projects: [], threads: [{ id: "mcp:thread-1" }] }),
    call: async () => ({ projects: [], threads: [] }),
    get: async () => ({ projection: { visibleTurnItems: items }, historyCursor: null, hasMoreHistory: false }),
  };

  const words = await readThreadWords(client as never, "thread-1", events);

  expect(words.map((word) => [word.id, word.text, word.answered])).toEqual([
    ["m1", "Yes, run it.", "Shall I run round 3?"],
    ["m2", "Yes from the phone.", "Shall I run round 3?"],
    ["q1:0", "Accept both (Recommended)", "Accept both gaps?"],
  ]);
});
