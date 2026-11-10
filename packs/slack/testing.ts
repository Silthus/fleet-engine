export type Message = { user: string; ts: string; text: string };
type Envelope = Record<string, unknown>;

export function startSlackStub(thread: Message[], ownerId: string, appTokens?: Set<string>) {
  const calls: Array<{ method: string; args: Record<string, string>; token: string | null }> = [];
  const acked: string[] = [];
  const sockets: Array<{ send(text: string): void; close(): void }> = [];
  const waiters: Array<{ until: () => boolean; resolve: () => void }> = [];
  const settle = () => waiters.splice(0).forEach((waiter) => (waiter.until() ? waiter.resolve() : waiters.push(waiter)));
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/socket") return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
      const method = url.pathname.replace(/^\/api\//, "");
      const args = Object.fromEntries(new URLSearchParams(await request.text()));
      calls.push({ method, args, token: request.headers.get("authorization") });
      queueMicrotask(settle);
      if (method === "apps.connections.open") {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        return Response.json(!appTokens || appTokens.has(token) ? { ok: true, url: `ws://127.0.0.1:${server.port}/socket` } : { ok: false, error: "invalid_auth" });
      }
      if (method === "auth.test") return Response.json({ ok: true, user_id: ownerId });
      if (method === "conversations.replies") {
        const found = thread.filter((message) => args.limit === "1" ? message.ts === args.ts : true).map((message) => ({ ...message, thread_ts: thread[0]!.ts }));
        return Response.json({ ok: true, messages: found });
      }
      if (method === "chat.getPermalink") return Response.json({ ok: true, permalink: `https://example.slack.com/archives/${args.channel}/p${args.message_ts}` });
      if (method === "users.info") return Response.json({ ok: true, user: { real_name: args.user === ownerId ? "Nora" : "Sam" } });
      return Response.json({ ok: true });
    },
    websocket: {
      open(socket) {
        sockets.push(socket);
        socket.send(JSON.stringify({ type: "hello" }));
        queueMicrotask(settle);
      },
      message(_socket, raw) {
        acked.push(JSON.parse(String(raw)).envelope_id);
        settle();
      },
    },
  });
  let id = 0;
  return {
    base: `http://127.0.0.1:${server.port}/api`,
    calls,
    acked,
    send(event: Envelope) {
      const envelope_id = `envelope-${++id}`;
      sockets.at(-1)!.send(JSON.stringify({ type: "events_api", envelope_id, payload: { event } }));
      return envelope_id;
    },
    until(check: () => boolean) {
      return new Promise<void>((resolve) => {
        waiters.push({ until: check, resolve });
        settle();
      });
    },
    method: (name: string) => calls.filter((call) => call.method === name),
    connected(count = 1) {
      return this.until(() => sockets.length >= count);
    },
    stop: () => void server.stop(true),
  };
}
