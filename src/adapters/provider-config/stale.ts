import type { Provider } from "../../pack/types.ts";
import { get, isDocument, type Document } from "./fields.ts";

export const proxyPort = "8317";

export function pointsAtProxy(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).port === proxyPort;
  } catch {
    return false;
  }
}

/** Proxy keys a Hub pack once wrote. free says whether no pack owns a path and the user did not change it. */
export function staleKeys(provider: Provider, document: Document, isFree: (path: string[]) => boolean): string[][] {
  const free = (path: string[]) => isFree(path) && get(document, path) !== undefined;
  const stale: string[][] = [];
  if (provider === "claude") {
    const base = ["env", "ANTHROPIC_BASE_URL"];
    const token = ["env", "ANTHROPIC_AUTH_TOKEN"];
    if (free(base) && pointsAtProxy(get(document, base))) stale.push(base, ...(free(token) ? [token] : []));
  }
  if (provider === "codex") {
    const providers = get(document, ["model_providers"]);
    const names = isDocument(providers) ? Object.keys(providers).filter((name) => free(["model_providers", name]) && pointsAtProxy(get(document, ["model_providers", name, "base_url"]))) : [];
    stale.push(...names.map((name) => ["model_providers", name]));
    const selected = get(document, ["model_provider"]);
    if (free(["model_provider"]) && typeof selected === "string" && names.includes(selected)) stale.push(["model_provider"]);
  }
  return stale;
}
