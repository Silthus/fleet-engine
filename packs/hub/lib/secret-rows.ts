import type { Env } from "./hub-transport.ts";
import type { Provider, SecretRow } from "./secret-store.ts";

export type ProviderOptions = Record<string, string>;
export type ProviderFactory = (options: ProviderOptions) => Provider;
export type ProviderLookup = (name: string, options?: ProviderOptions) => Provider;
export type SecretRowsModule = { rows: (provider: ProviderLookup) => SecretRow[] };
export type SecretProvidersModule = { providers: Record<string, ProviderFactory> };

export const rowsSeam = "secret-rows";
export const providersSeam = "secret-providers";

const handlers = (env: Env) => JSON.parse(env.FLEET_HANDLERS || "{}") as Record<string, string>;

const notInstalled = (name: string): Provider => ({ name, check: async () => ({ ok: false, reason: `no pack on this hub brings the ${name} provider, so the value cannot be checked. Turn on the pack that brings it` }) });

export function lookup(providers: Record<string, ProviderFactory>): ProviderLookup {
  return (name, options = {}) => Object.hasOwn(providers, name) ? providers[name]!(options) : notInstalled(name);
}

export function checkedRows(rows: SecretRow[]): SecretRow[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(row.name)) throw new Error(`The secret row ${JSON.stringify(row.name)} needs a name of lowercase letters, digits and hyphens`);
    if (seen.has(row.name)) throw new Error(`Two secret rows are named ${row.name}`);
    if (!row.env.length || row.env.some((key) => !/^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error(`The secret row ${row.name} needs one or more variable names such as API_KEY`);
    if (row.file && (row.file.path.startsWith("/") || row.file.path.split("/").includes(".."))) throw new Error(`The secret row ${row.name} names its file by a path under the home, not ${row.file.path}`);
    seen.add(row.name);
  }
  return rows;
}

export async function injectedRows(env: Env): Promise<SecretRow[]> {
  const { [rowsSeam]: rowsPath, [providersSeam]: providersPath } = handlers(env);
  if (!rowsPath) return [];
  const providers = providersPath ? ((await import(providersPath)) as SecretProvidersModule).providers : {};
  return checkedRows(((await import(rowsPath)) as SecretRowsModule).rows(lookup(providers)));
}
