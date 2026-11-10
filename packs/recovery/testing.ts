import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRow } from "../base/lib/models.ts";
import type { Fetch } from "../hub/lib/mcphub/client.ts";

export const proxyKey = "ab".repeat(32);

export const modelRows: ModelRow[] = [
  { role: "implementation", work: "Implementation", provider: "claude", model: "claude-test-1", effort: "high" },
  { role: "lookup", work: "Lookups", provider: "claude", model: "claude-test-small", effort: "medium" },
  { role: "review", work: "Review", provider: "codex", model: "gpt-test-1", effort: "high" },
];

export function recoveryHome(home: string): string {
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/cli-proxy.key"), `${proxyKey}\n`, { mode: 0o600 });
  return home;
}

type Answer = number | [number, string];

export function fakeProxy(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.origin !== "http://127.0.0.1:8317") throw new TypeError(`fetch failed: ${url.origin}`);
    if (headers.get("authorization") !== `Bearer ${proxyKey}`) return new Response("unauthorized", { status: 401 });
    if (init?.method !== "POST") return new Response("method not allowed", { status: 405 });
    const request = JSON.parse(String(init.body)) as { model?: unknown; messages?: unknown; max_tokens?: unknown; input?: unknown };
    if (!wellFormed(url.pathname, request)) return new Response('{"error":{"type":"invalid_request_error"}}', { status: 400 });
    const model = String(request.model);
    calls.push(`${url.pathname} ${model}`);
    const answer = answers[model];
    if (answer === undefined) throw new TypeError("fetch failed: connection refused");
    const [status, text] = typeof answer === "number" ? [answer, bodyFor(answer)] : answer;
    return new Response(text, { status });
  };
  return { fetch, calls };
}

function wellFormed(path: string, request: { model?: unknown; messages?: unknown; max_tokens?: unknown; input?: unknown }): boolean {
  if (typeof request.model !== "string") return false;
  if (path === "/v1/messages") return Array.isArray(request.messages) && request.messages.length > 0 && typeof request.max_tokens === "number";
  if (path === "/v1/responses") return typeof request.input === "string" || Array.isArray(request.input);
  return false;
}

function bodyFor(code: number): string {
  return code === 200 ? "{}" : code === 429 ? '{"error":{"type":"rate_limit_error"}}' : "error";
}

type ThreadFields = Record<string, unknown>;

export type DeliveredMessage = { threadId: string; text: string; continuesRunId?: string };

export function t3Inbox(threads: ThreadFields[] = []) {
  const byCommand = new Map<string, DeliveredMessage>();
  const rpc = (tag: string, payload: unknown) => {
    if (tag !== "orchestration.dispatchCommand") return undefined;
    const message = payload as Record<string, unknown>;
    const shaped = message.type === "message.dispatch" && typeof message.commandId === "string" && message.messageId === message.commandId
      && typeof message.threadId === "string" && typeof message.text === "string" && Array.isArray(message.attachments)
      && (message.dispatchMode as { type?: string })?.type === "start_immediately";
    if (!shaped) return undefined;
    if (message.manualContinuationOfRunId !== undefined && !resumable(threads.find((thread) => thread.id === message.threadId), message.manualContinuationOfRunId)) return undefined;
    if (!byCommand.has(message.commandId as string)) {
      byCommand.set(message.commandId as string, {
        threadId: message.threadId as string, text: message.text as string,
        ...(typeof message.manualContinuationOfRunId === "string" ? { continuesRunId: message.manualContinuationOfRunId } : {}),
      });
    }
    return { sequence: byCommand.size };
  };
  return { rpc, delivered: () => [...byCommand.values()] };
}


function resumable(thread: ThreadFields | undefined, runId: unknown): boolean {
  if (!thread || thread.latestRunId !== runId || thread.archivedAt || thread.deletedAt || thread.pendingRuntimeRequest) return false;
  return thread.status === "interrupted" || (thread.status === "failed" && thread.lastErrorClass === "usage_limit");
}

export function limitedThread(id: string, fields: ThreadFields = {}): ThreadFields {
  return {
    id, title: `Thread ${id}`, projectId: "project", status: "failed", lastErrorClass: "usage_limit", lastError: "You've hit your usage limit.",
    latestRunId: `run-${id}`, latestRunCompletedAt: "2026-11-10T19:00:00.000Z", providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-test-1" }, ...fields,
  };
}
