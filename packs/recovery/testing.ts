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

/** The hub's proxy as Claude and Codex reach it: one answer per model, and a refused connection for a model it does not know. */
export function fakeProxy(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.origin !== "http://127.0.0.1:8317") throw new TypeError(`fetch failed: ${url.origin}`);
    if (headers.get("authorization") !== `Bearer ${proxyKey}`) return new Response("unauthorized", { status: 401 });
    const { model } = JSON.parse(String(init?.body)) as { model: string };
    calls.push(`${url.pathname} ${model}`);
    const answer = answers[model];
    if (answer === undefined) throw new TypeError("fetch failed: connection refused");
    const [status, text] = typeof answer === "number" ? [answer, bodyFor(answer)] : answer;
    return new Response(text, { status });
  };
  return { fetch, calls };
}

function bodyFor(code: number): string {
  return code === 200 ? "{}" : code === 429 ? '{"error":{"type":"rate_limit_error"}}' : "error";
}
