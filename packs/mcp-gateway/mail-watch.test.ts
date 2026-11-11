import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { t3Threads } from "../../src/integrations/t3/index.ts";
import { startT3Stub, type LaunchedThread } from "../../src/integrations/t3/testing.ts";
import type { ShellThread } from "../../src/integrations/t3/threads.ts";
import type { ModelRow } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { checkMail, defaultQuery, type MailWatch } from "./lib/mail-watch.ts";

const temp = tempDirs();
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  temp.cleanup();
});

const key = "mcphub_hub-key";
const minute = 60_000;
const start = Date.parse("2026-11-11T07:00:00Z");
const models: ModelRow[] = [
  { role: "survey", work: "Survey", provider: "claude", model: "claude-mid", effort: "high" },
  { role: "lookup", work: "Lookups", provider: "claude", model: "claude-small", effort: "medium" },
];

type Mail = { id: string; thread_id: string; from_: string; subject: string; at: number; sent?: true; archived?: true };

function gateway() {
  const mailbox: Mail[] = [];
  const state = { signedIn: true, failRead: undefined as string | undefined, sessions: new Set<string>(), opened: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/mcphub/mcp/fleet") return new Response(null, { status: 404 });
      if (request.headers.get("authorization") !== `Bearer ${key}`) return new Response(null, { status: 401 });
      const session = request.headers.get("mcp-session-id") ?? "";
      if (request.method === "DELETE") return new Response(null, { status: state.sessions.delete(session) ? 200 : 404 });
      const body = (await request.json()) as { id?: number; method: string; params?: { name: string; arguments: Record<string, any> } };
      if (body.method === "initialize") {
        const id = `session-${++state.opened}`;
        state.sessions.add(id);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }, { headers: { "mcp-session-id": id } });
      }
      if (!state.sessions.has(session)) return new Response(null, { status: 404 });
      if (body.method !== "tools/call") return new Response(null, { status: 202 });
      const { name, arguments: args } = body.params!;
      const answer = !state.signedIn ? { error: "The Gmail app is not connected to the bridge's ChatGPT sign-in." }
        : name === "gmail-read_email_thread" && args.thread_id === state.failRead ? { error: "Gmail is unavailable." } : tool(mailbox, name, args);
      const result = "error" in answer ? { isError: true, content: [{ type: "text", text: answer.error }] } : { content: [{ type: "text", text: JSON.stringify(answer) }] };
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, mailbox, state };
}

function tool(mailbox: Mail[], name: string, args: Record<string, any>): Record<string, unknown> | { error: string } {
  if (name === "gmail-search_emails") {
    const unknown = Object.keys(args).find((arg) => !["query", "max_results", "next_page_token"].includes(arg));
    if (unknown) return { error: `unknown argument ${unknown}` };
    const after = Number(/after:(\d+)/.exec(args.query)?.[1] ?? 0) * 1000;
    const matches = mailbox.filter((mail) => !mail.sent && !mail.archived && mail.at > after).toReversed();
    const offset = Number(args.next_page_token ?? 0);
    const page = matches.slice(offset, offset + args.max_results);
    const more = offset + args.max_results < matches.length;
    return { emails: page.map(({ id, thread_id, from_, subject, at }) => ({ id, thread_id, from_, subject, email_ts: new Date(at).toISOString(), display_url: `https://mail.example/${thread_id}` })), ...(more && { next_page_token: String(offset + args.max_results) }) };
  }
  if (name === "gmail-read_email_thread") {
    const messages = mailbox.filter((mail) => mail.thread_id === args.thread_id);
    return { messages: messages.map((mail) => ({ id: mail.id, label_ids: mail.sent ? ["SENT"] : ["INBOX"], internal_date: String(mail.at) })) };
  }
  return { error: `Tool not found: ${name}` };
}

async function t3() {
  const shell = { projects: [], threads: [] as ShellThread[] };
  const delivered: { threadId: string; text: string }[] = [];
  const faults = { refuse: (_model: string) => false, lose: new Set<string>() };
  let launched = 0;
  const stub = await startT3Stub({
    shell,
    environmentId: "env-1",
    rpc(tag, payload: any) {
      if (tag === "projects.ensureScratch") return { projectId: "scratch" };
      if (tag === "orchestration.launchThread" && !faults.refuse(payload.modelSelection.model)) {
        const id = `thread-${++launched}`;
        shell.threads.push({ id, title: payload.title, projectId: "scratch", status: "idle" });
        return { threadId: id };
      }
      if (tag === "orchestration.dispatchCommand") return delivered.push({ threadId: payload.threadId, text: payload.text }), {};
    },
    loseAnswer: (tag) => faults.lose.delete(tag),
  });
  stops.push(() => stub.stop());
  return { stub, shell, delivered, faults, launches: stub.threads as LaunchedThread[] };
}

async function setup() {
  const mail = gateway();
  const t3Server = await t3();
  let now = start;
  const lines: string[] = [];
  const watch: MailWatch = {
    gateway: { url: mail.url, credential: key },
    threads: t3Threads(models, { home: t3Server.stub.home }),
    statePath: join(temp.make("state-"), "mail-watch.json"),
    query: defaultQuery,
    now: () => now,
    log: (line) => lines.push(line),
    fetch: (input, init) => fetch(input, init),
  };
  const later = (ms: number) => (now += ms);
  const sent = (id: string, thread_id: string) => mail.mailbox.push({ id, thread_id, from_: "Me <me@example.com>", subject: "Quote", at: now, sent: true });
  const received = (id: string, thread_id: string, from_ = "Ada Lovelace <ada@example.com>", subject = "Re: Quote") => mail.mailbox.push({ id, thread_id, from_, subject, at: now });
  const check = (dryRun?: boolean) => checkMail(watch, dryRun);
  const conversation = async () => (await check(), sent("m1", "conv-1"), later(minute), received("m2", "conv-1"));
  return { mail, t3: t3Server, watch, lines, later, sent, received, conversation, check };
}

test("the first check only arms the watch, and a reply that arrives later in a conversation you wrote in starts one thread about it", async () => {
  const { t3, later, sent, received, check } = await setup();
  sent("m1", "conv-1");
  later(minute);
  received("m2", "conv-1");
  expect(await check()).toBe(true);
  expect(t3.launches).toEqual([]);
  later(2 * minute);
  received("m3", "conv-1");
  expect(await check()).toBe(true);
  expect(t3.launches.map((thread) => thread.title)).toEqual(["Mail: Ada Lovelace: Re: Quote"]);
  expect(t3.launches[0]!.prompt).toContain('thread_id "conv-1"');
  expect(t3.launches[0]!.modelSelection).toMatchObject({ model: "claude-mid" });
  later(2 * minute);
  expect(await check()).toBe(true);
  expect(t3.launches).toHaveLength(1);
  expect(t3.delivered).toEqual([]);
});

test("a later reply in the same conversation goes to that thread, and mail in a conversation you never wrote in starts nothing", async () => {
  const { t3, later, received, conversation, check } = await setup();
  await conversation();
  received("n1", "newsletter", "Shop <news@shop.example>", "Sale");
  await check();
  later(5 * minute);
  received("m3", "conv-1", "Ada Lovelace <ada@example.com>", "Re: Quote, again");
  await check();
  expect(t3.launches.map((thread) => thread.id)).toEqual(["thread-1"]);
  expect(t3.delivered).toEqual([{ threadId: "thread-1", text: expect.stringContaining("Re: Quote, again") }]);
});

test("a reply whose thread could not start is delivered later, even after you archived it and the look-back window passed", async () => {
  const { mail, t3, later, received, conversation, check, lines } = await setup();
  await conversation();
  t3.faults.refuse = () => true;
  await check();
  expect(lines.at(-1)).toBe("Could not reach a thread for conv-1; the next check tries again.");
  mail.mailbox.find((item) => item.id === "m2")!.archived = true;
  received("m3", "conv-1", "Ada Lovelace <ada@example.com>", "Re: Quote, later");
  for (let checks = 0; checks < 15; checks++, later(2 * minute)) await check();
  expect(t3.launches).toEqual([]);
  t3.faults.refuse = () => false;
  expect(await check()).toBe(true);
  expect(t3.launches.map((thread) => thread.title)).toEqual(["Mail: Ada Lovelace: Re: Quote"]);
  expect(t3.launches[0]!.prompt).toMatch(/Subject: Re: Quote\n[^]*Subject: Re: Quote, later\n/);
});

test("a reply in a conversation whose thread is gone starts a new thread", async () => {
  const { t3, later, received, conversation, check } = await setup();
  await conversation();
  await check();
  t3.shell.threads.splice(0);
  later(2 * minute);
  received("m3", "conv-1");
  await check();
  expect(t3.launches.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
  expect(t3.delivered).toEqual([]);
});

test("a follow-up whose answer from T3 is lost goes to the same thread again, and never starts a second thread", async () => {
  const { t3, later, received, conversation, check } = await setup();
  await conversation();
  await check();
  later(2 * minute);
  received("m3", "conv-1");
  t3.faults.lose.add("orchestration.dispatchCommand");
  expect(await check()).toBe(false);
  later(2 * minute);
  expect(await check()).toBe(true);
  expect(t3.launches.map((thread) => thread.id)).toEqual(["thread-1"]);
  expect(t3.delivered.map((message) => message.threadId)).toEqual(["thread-1", "thread-1"]);
});

test("when T3 starts the first thread but its answer is lost, a newer reply still lands in that one thread", async () => {
  const { t3, later, received, conversation, check } = await setup();
  await conversation();
  t3.faults.lose.add("orchestration.launchThread");
  expect(await check()).toBe(false);
  later(2 * minute);
  received("m3", "conv-1", "Ada Lovelace <ada@example.com>", "Re: Quote, again");
  await check();
  later(2 * minute);
  received("m4", "conv-1", "Ada Lovelace <ada@example.com>", "Re: Quote, third");
  await check();
  expect(t3.launches.map((thread) => thread.id)).toEqual(["thread-1"]);
  expect(t3.delivered).toEqual([{ threadId: "thread-1", text: expect.stringContaining("Re: Quote, third") }]);
});

test("a reply delivered in a check where another conversation fails is not delivered again", async () => {
  const { mail, t3, later, sent, received, conversation, check } = await setup();
  await conversation();
  sent("o1", "conv-2");
  await check();
  later(2 * minute);
  received("m3", "conv-1");
  received("o2", "conv-2");
  mail.state.failRead = "conv-2";
  expect(await check()).toBe(false);
  mail.state.failRead = undefined;
  later(2 * minute);
  expect(await check()).toBe(true);
  expect(t3.delivered.map((message) => message.threadId)).toEqual(["thread-1"]);
  expect(t3.launches.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
});

test("mail that arrived before the watch was armed starts nothing", async () => {
  const { t3, later, sent, received, check } = await setup();
  sent("m1", "conv-1");
  later(minute);
  received("m2", "conv-1");
  later(5 * minute);
  await check();
  later(2 * minute);
  await check();
  expect(t3.launches).toEqual([]);
});

test("after twenty minutes of failed checks, one thread says the watch is failing and why; a working check ends the streak", async () => {
  const { mail, t3, later, check } = await setup();
  await check();
  mail.state.signedIn = false;
  for (let checks = 0; checks < 10; checks++, later(2 * minute)) expect(await check()).toBe(false);
  expect(t3.launches).toEqual([]);
  for (let checks = 0; checks < 3; checks++, later(2 * minute)) await check();
  expect(t3.launches.map((thread) => thread.title)).toEqual(["Mail watch is failing"]);
  expect(t3.launches[0]!.prompt).toContain("The Gmail app is not connected");
  mail.state.signedIn = true;
  expect(await check()).toBe(true);
  mail.state.signedIn = false;
  for (let checks = 0; checks < 12; checks++, later(2 * minute)) await check();
  expect(t3.launches.map((thread) => thread.title)).toEqual(["Mail watch is failing", "Mail watch is failing"]);
});

test("a reply that waits twenty minutes for its thread starts an alert on the lookup model", async () => {
  const { t3, later, conversation, check } = await setup();
  await conversation();
  t3.faults.refuse = (model) => model === "claude-mid";
  for (let checks = 0; checks < 12; checks++, later(2 * minute)) expect(await check()).toBe(false);
  expect(t3.launches.map((thread) => [thread.title, thread.modelSelection])).toEqual([["Mail watch is failing", expect.objectContaining({ model: "claude-small" })]]);
  expect(t3.launches[0]!.prompt).toContain("Could not reach a thread for conv-1");
});

test("a dry run says which conversation would get a thread, and starts nothing and remembers nothing", async () => {
  const { t3, watch, conversation, check, lines } = await setup();
  expect(await check(true)).toBe(true);
  expect(existsSync(watch.statePath)).toBe(false);
  await conversation();
  await check(true);
  expect(lines).toContain("Would notify: 1 new in conv-1.");
  expect(t3.launches).toEqual([]);
  await check();
  expect(t3.launches).toHaveLength(1);
});

test("a gateway that refuses the hub's key fails the check with a sentence that says how to fix it", async () => {
  const { watch, lines, check } = await setup();
  await check();
  watch.gateway.credential = "mcphub_other";
  expect(await check()).toBe(false);
  expect(lines.at(-1)).toBe("Check failed: The MCP gateway refused the hub's key. Run fleet apply on the hub.");
});

test("a reply under eleven pages of newer mail still starts its thread", async () => {
  const { t3, received, conversation, check } = await setup();
  await conversation();
  for (let index = 0; index < 550; index++) received(`n${index}`, "newsletter", "Shop <news@shop.example>", "Sale");
  await check();
  expect(t3.launches.map((thread) => thread.title)).toEqual(["Mail: Ada Lovelace: Re: Quote"]);
});

test("each check closes its gateway session", async () => {
  const { mail, conversation, check } = await setup();
  await conversation();
  await check();
  await check();
  expect(mail.state.opened).toBe(2);
  expect(mail.state.sessions.size).toBe(0);
});
