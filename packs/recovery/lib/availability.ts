import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writePrivateFile } from "../../../src/files/private.ts";
import { modelTable, type ModelRow } from "../../base/lib/models.ts";
import { proxyUrl } from "../../hub/lib/cli-proxy-balance.ts";
import type { Fetch } from "../../mcp-gateway/lib/client.ts";
import { availabilityPath, providers, readAvailability, type Availability, type Provider, type ProviderStatus } from "../../base/lib/t3/index.ts";
import { isQuotaError } from "./quota.ts";

export type { Availability, Provider } from "../../base/lib/t3/index.ts";
export type ProbeContext = { home: string; env: Record<string, string | undefined>; fetch: Fetch; now: () => number };
export type ProvidersContext = ProbeContext & { print: (line: string) => void };

const probeTimeoutMs = 10_000;
const keyPattern = /^([0-9a-f]{64})\n?$/;

export async function providersCommand(args: string[], context: ProvidersContext): Promise<number> {
  const json = args.length === 1 && args[0] === "--json";
  if (args.length && !json) return context.print("Usage: fleet providers [--json]"), 2;
  const report = await currentAvailability(context);
  if (json) context.print(JSON.stringify(report, null, 2));
  else for (const provider of providers) context.print(`${provider}: ${report.providers[provider]} (checked ${report.checkedAt})`);
  return 0;
}

export async function currentAvailability(context: ProbeContext): Promise<Availability> {
  const saved = readAvailability(context.home, context.now());
  if (saved) return saved;
  const key = proxyKey(context.home);
  const rows = modelTable(context.env);
  const statuses = await Promise.all(providers.map((provider) => probe(context.fetch, key, probeModel(rows, provider), provider)));
  const report: Availability = { checkedAt: new Date(context.now()).toISOString(), providers: { claude: statuses[0]!, codex: statuses[1]! } };
  const path = availabilityPath(context.home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writePrivateFile(path, `${JSON.stringify(report)}\n`);
  return report;
}

function proxyKey(home: string): string | undefined {
  try { return keyPattern.exec(readFileSync(join(home, ".config/fleet/cli-proxy.key"), "utf8"))?.[1]; }
  catch { return undefined; }
}

function probeModel(rows: ModelRow[], provider: Provider): string | undefined {
  const own = rows.filter((row) => row.provider === provider);
  return (own.find((row) => row.role === "implementation") ?? own[0])?.model;
}

async function probe(fetch: Fetch, key: string | undefined, model: string | undefined, provider: Provider): Promise<ProviderStatus> {
  if (!key || !model) return "unknown";
  const codex = provider === "codex";
  try {
    const response = await fetch(`${proxyUrl}${codex ? "/v1/responses" : "/v1/messages"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "x-api-key": key, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(codex ? { model, input: "Reply ok.", max_output_tokens: 16 } : { model, max_tokens: 1, messages: [{ role: "user", content: "Reply ok." }] }),
      signal: AbortSignal.timeout(probeTimeoutMs),
      redirect: "error",
    });
    if (response.status === 200) return await response.body?.cancel(), "available";
    const text = await response.text().catch(() => "");
    return response.status === 429 || isQuotaError(text) ? "exhausted" : "unknown";
  } catch {
    return "unknown";
  }
}
