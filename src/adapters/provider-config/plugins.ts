import { withoutCredentials } from "../../credentials.ts";
import type { Finding, Plan } from "../../pack/types.ts";
import type { CommandRunner } from "../run.ts";
import { get, keyPath, type Document } from "./fields.ts";
import { readState, writeWithBackups } from "./store.ts";

export const pluginsTarget = ".config/fleet/plugins.json";
const pluginId = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/;

export type Manager = "claude" | "codex";
type Owned = Record<Manager, string[]>;
type Cli = (args: string[]) => ReturnType<CommandRunner>;
type Sources = Record<string, string | null>;

const managers: Manager[] = ["claude", "codex"];
const names: Record<Manager, string> = { claude: "Claude", codex: "Codex" };
const officialMarketplaces: Sources = { "claude-plugins-official": "anthropics/claude-plugins-official" };

const declared: Record<Manager, (path: string[]) => string | undefined> = {
  claude: ([root, id, ...rest]) => (root === "enabledPlugins" && id && !rest.length ? id : undefined),
  codex: ([root, id, field, ...rest]) => (root === "plugins" && id && field === "enabled" && !rest.length ? id : undefined),
};

const commands: Record<Manager, { list: string[]; install: (id: string) => string[]; remove: (id: string) => string[]; clearEnv: string[] }> = {
  claude: { list: ["list", "--json"], install: (id) => ["install", id, "--scope", "user"], remove: (id) => ["uninstall", id, "--scope", "user", "--keep-data"], clearEnv: [] },
  codex: { list: ["list", "--json"], install: (id) => ["add", id, "--json"], remove: (id) => ["remove", id, "--json"], clearEnv: ["CODEX_HOME"] },
};

export function wantedPlugins(plan: Plan, manager: Manager = "claude") {
  return plan.config.flatMap((entry) => {
    const id = entry.provider === manager && entry.value === true ? declared[manager](keyPath(entry.key)) : undefined;
    if (id === undefined) return [];
    if (!pluginId.test(id)) throw new Error(`${entry.pack} enables an invalid ${names[manager]} plugin id: ${id}`);
    return [id];
  });
}

export function acceptedPlugins(manager: Manager, document: Document) {
  const root = get(document, manager === "claude" ? ["enabledPlugins"] : ["plugins"]);
  if (!root || typeof root !== "object") return [];
  return Object.entries(root).flatMap(([id, on]) => ((manager === "claude" ? on : (on as { enabled?: unknown } | null)?.enabled) === true ? [id] : []));
}

/** Installs the plugins packs enable, through each provider's CLI in the given home. Removes only plugins that Fleet installed. */
export async function reconcilePlugins(plan: Plan, home: string, dryRun: boolean, run: CommandRunner, settings: { outage: boolean; accepted?: Partial<Owned>; marketplaces?: Sources }): Promise<Finding[]> {
  const text = await readState(home, pluginsTarget);
  const { owned, inherited } = parseOwned(text);
  const findings: Finding[] = [];
  const next: Owned = { claude: [], codex: [] };
  for (const manager of managers) {
    const result = await reconcileManager(manager, plan, home, dryRun, run, settings, owned[manager], inherited[manager]);
    findings.push(...result.findings);
    next[manager] = result.owned;
  }
  if (dryRun || (text !== undefined && !Object.values(inherited).every((ids) => !ids.length) && !next.claude.length && !next.codex.length)) return findings;
  const after = `${JSON.stringify(next.codex.length ? next : { claude: next.claude }, null, 2)}\n`;
  if (after !== (text ?? `${JSON.stringify({ claude: [] }, null, 2)}\n`)) await writeWithBackups(home, [{ target: pluginsTarget, before: text, after }]);
  return findings;
}

async function reconcileManager(manager: Manager, plan: Plan, home: string, dryRun: boolean, run: CommandRunner, settings: { outage: boolean; accepted?: Partial<Owned>; marketplaces?: Sources }, previous: string[], inherited: string[]): Promise<{ findings: Finding[]; owned: string[] }> {
  const outage = settings.outage;
  const name = names[manager];
  const planned = wantedPlugins(plan, manager);
  const accepted = settings.accepted?.[manager];
  const wanted = planned.filter((id) => accepted?.includes(id));
  if (!planned.length && !previous.length) return { findings: [], owned: previous };
  if (!accepted) return { findings: planned.length ? [{ id: `plugins:${manager}`, pack: "engine", say: `${name} plugins wait until Fleet can change ${manager === "claude" ? ".claude/settings.json" : ".codex/config.toml"}: ${planned.join(", ")}.`, repair: "apply" }] : [], owned: previous };
  const cli: Cli = (args) => run([manager, "plugin", ...args], { home, ...(commands[manager].clearEnv.length ? { clearEnv: commands[manager].clearEnv } : {}) });
  const installed = await listInstalled(manager, cli);
  if (!installed) {
    return { findings: planned.length ? [{ id: `plugins:${manager}`, pack: "engine", say: `${manager === "claude" ? "Claude Code" : "Codex"} is not installed yet, so its plugins wait: ${planned.join(", ")}.`, repair: "apply" }] : [], owned: previous };
  }
  const owned = [...new Set([...previous, ...inherited.filter((id) => planned.includes(id))])];
  const missing = wanted.filter((id) => !installed.includes(id));
  const departed = outage ? [] : owned.filter((id) => !planned.includes(id) && installed.includes(id));
  if (dryRun) {
    return {
      owned,
      findings: [
        ...missing.map((id) => ({ id: `plugin:${id}`, pack: "engine", say: `The ${name} plugin ${id} needs to be installed.`, repair: "apply" as const })),
        ...departed.map((id) => ({ id: `plugin:${id}`, pack: "engine", say: `The ${name} plugin ${id} needs to be removed.`, repair: "apply" as const })),
      ],
    };
  }
  const { findings, unreachable } = manager === "claude" ? await fetchMarketplaces(cli, missing, { ...officialMarketplaces, ...settings.marketplaces }) : { findings: [] as Finding[], unreachable: [] as string[] };
  const next = new Set(owned.filter((id) => installed.includes(id) || (outage && !planned.includes(id))));
  for (const id of missing.filter((id) => !unreachable.includes(marketplaceOf(id)))) {
    if ((await cli(commands[manager].install(id))).code === 0) next.add(id);
    else findings.push({ id: `plugin:${id}`, pack: "engine", say: `Could not install the ${name} plugin ${id}.`, repair: "apply" });
  }
  for (const id of departed) {
    if ((await cli(commands[manager].remove(id))).code === 0) next.delete(id);
    else findings.push({ id: `plugin:${id}`, pack: "engine", say: `Could not remove the ${name} plugin ${id}.`, repair: "apply" });
  }
  return { findings, owned: [...next].sort() };
}

export function declaredMarketplaces(settings: Document): Sources {
  const declared = get(settings, ["extraKnownMarketplaces"]);
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return {};
  return Object.fromEntries(Object.entries(declared).map(([name, entry]) => [name, addSource((entry as { source?: unknown } | null)?.source) ?? null]));
}

const addSourceField: Record<string, string> = { github: "repo", git: "url", url: "url", directory: "path", file: "path" };

function addSource(source: unknown) {
  if (!source || typeof source !== "object") return undefined;
  const { source: kind, ...fields } = source as Record<string, unknown>;
  const field = typeof kind === "string" ? addSourceField[kind] : undefined;
  const value = field ? fields[field] : undefined;
  return Object.keys(fields).length === 1 && typeof value === "string" ? value : undefined;
}

async function fetchMarketplaces(claude: Cli, plugins: string[], sources: Sources): Promise<{ findings: Finding[]; unreachable: string[] }> {
  const needed = [...new Set(plugins.map(marketplaceOf))];
  const fetched = needed.length ? await listMarketplaces(claude) : undefined;
  const findings: Finding[] = [];
  const unreachable: string[] = [];
  for (const name of fetched ? needed : []) {
    const source = Object.hasOwn(sources, name) ? sources[name] : undefined;
    if (fetched!.includes(name)) {
      const updated = await claude(["marketplace", "update", name]);
      if (updated.code !== 0) findings.push({ id: `plugin-marketplace:${name}`, pack: "engine", say: `Could not update the Claude plugin marketplace ${name}: ${reasonOf(updated)}.`, repair: "apply" });
      continue;
    }
    if (!source) continue;
    const added = await claude(["marketplace", "add", source, "--scope", "user"]);
    if (added.code === 0) continue;
    unreachable.push(name);
    const waiting = plugins.filter((id) => marketplaceOf(id) === name).join(", ");
    findings.push({ id: `plugin-marketplace:${name}`, pack: "engine", say: `Could not add the Claude plugin marketplace ${name} from ${withoutCredentials(source)}: ${reasonOf(added)}. Its plugins wait: ${waiting}.`, repair: "apply" });
  }
  return { findings, unreachable };
}

async function listMarketplaces(claude: Cli): Promise<string[] | undefined> {
  const result = await claude(["marketplace", "list", "--json"]);
  if (result.code !== 0) return undefined;
  try {
    const entries = JSON.parse(result.stdout) as unknown;
    return Array.isArray(entries) ? entries.flatMap((entry) => (entry && typeof entry.name === "string" ? [entry.name as string] : [])) : undefined;
  } catch {
    return undefined;
  }
}

const marketplaceOf = (id: string) => id.slice(id.indexOf("@") + 1);
const reasonOf = (result: { code: number; stdout: string; stderr?: string }) => withoutCredentials((result.stderr || result.stdout).trim().split("\n")[0]!.replace(/^✘\s*/, "").replace(/\.$/, "")) || `exit ${result.code}`;

async function listInstalled(manager: Manager, cli: Cli): Promise<string[] | undefined> {
  const result = await cli(commands[manager].list);
  if (result.code !== 0) return undefined;
  const value = JSON.parse(result.stdout) as unknown;
  const entries = manager === "claude" ? value : (value as { installed?: unknown } | null)?.installed;
  if (!Array.isArray(entries)) throw new Error(`${names[manager]} printed an unknown plugin list format`);
  return manager === "claude"
    ? entries.flatMap((entry) => (entry && typeof entry.id === "string" && entry.scope === "user" ? [entry.id as string] : []))
    : entries.flatMap((entry) => (entry && typeof entry.pluginId === "string" && entry.installed !== false ? [entry.pluginId as string] : []));
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === "string");

function parseOwned(text: string | undefined): { owned: Owned; inherited: Owned } {
  const none = (): Owned => ({ claude: [], codex: [] });
  if (text === undefined) return { owned: none(), inherited: none() };
  const value = JSON.parse(text) as { claude?: unknown; codex?: unknown; version?: unknown; installed?: unknown };
  if (strings(value?.claude) && (value.codex === undefined || strings(value.codex))) return { owned: { claude: value.claude, codex: value.codex ?? [] }, inherited: none() };
  if (value?.version === 1 && Array.isArray(value.installed)) {
    const inherited = none();
    for (const entry of value.installed as Array<{ provider?: unknown; id?: unknown }>) {
      if ((entry?.provider === "claude" || entry?.provider === "codex") && typeof entry.id === "string") inherited[entry.provider].push(entry.id);
    }
    return { owned: none(), inherited };
  }
  throw new Error(`${pluginsTarget} is not a plugin record`);
}
