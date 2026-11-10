import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRow } from "../../pack/types.ts";

export type Provider = ModelRow["provider"];
export type ProviderStatus = "available" | "exhausted" | "unknown";
export type Availability = { checkedAt: string; providers: Record<Provider, ProviderStatus> };

export const providers: Provider[] = ["claude", "codex"];
export const availabilityReuseMs = 5 * 60_000;
const statuses: ProviderStatus[] = ["available", "exhausted", "unknown"];

export const availabilityPath = (home: string) => join(home, ".local/state/fleet/provider-availability.json");

export function readAvailability(home: string, now: number): Availability | undefined {
  try {
    const report = JSON.parse(readFileSync(availabilityPath(home), "utf8")) as Availability;
    const age = now - Date.parse(report.checkedAt);
    if (!(age >= 0 && age < availabilityReuseMs)) return undefined;
    if (!providers.every((provider) => statuses.includes(report.providers?.[provider]))) return undefined;
    return { checkedAt: report.checkedAt, providers: { claude: report.providers.claude, codex: report.providers.codex } };
  } catch {
    return undefined;
  }
}

export function exhaustedRefusal(home: string, row: ModelRow, title: string, now: number): string | undefined {
  const report = readAvailability(home, now);
  if (report?.providers[row.provider] !== "exhausted") return undefined;
  return `Fleet did not start "${title}": ${row.provider}, the provider of the ${row.role} model ${row.model}, has spent its quota (fleet providers checked ${report.checkedAt}). Wait until fleet providers says ${row.provider} is available, or start it on another model.`;
}
