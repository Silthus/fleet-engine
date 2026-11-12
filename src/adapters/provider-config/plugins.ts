import { withoutCredentials } from "../../credentials.ts";
import type { Finding, Plan } from "../../pack/types.ts";
import type { CommandRunner } from "../run.ts";
import { get, keyPath, type Document } from "./fields.ts";
import { readState, writeWithBackups } from "./store.ts";

export const pluginsTarget = ".config/fleet/plugins.json";
const pluginId = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/;

type Owned = { claude: string[] };
type Claude = (args: string[]) => ReturnType<CommandRunner>;

const officialMarketplaces: Record<string, string> = { "claude-plugins-official": "anthropics/claude-plugins-official" };

export function wantedPlugins(plan: Plan) {
  return plan.config.flatMap((entry) => {
    const [root, id, ...rest] = keyPath(entry.key);
    if (entry.provider !== "claude" || root !== "enabledPlugins" || !id || rest.length || entry.value !== true) return [];
    if (!pluginId.test(id)) throw new Error(`${entry.pack} enables an invalid Claude plugin id: ${id}`);
    return [id];
  });
}

/** Installs the plugins packs enable, through Claude Code in the given home. Removes only plugins that Fleet installed. */
export async function reconcilePlugins(plan: Plan, home: string, dryRun: boolean, run: CommandRunner, settings: { outage: boolean; accepted?: string[]; marketplaces?: Record<string, string> }): Promise<Finding[]> {
  const outage = settings.outage;
  const planned = wantedPlugins(plan);
  const wanted = planned.filter((id) => settings.accepted?.includes(id));
  const text = await readState(home, pluginsTarget);
  const owned = parseOwned(text);
  if (!planned.length && !owned.claude.length) return [];
  if (!settings.accepted) return planned.length ? [{ id: "plugins:claude", pack: "engine", say: `Claude plugins wait until Fleet can change .claude/settings.json: ${planned.join(", ")}.`, repair: "apply" }] : [];
  const claude = (args: string[]) => run(["claude", "plugin", ...args], { home });
  const installed = await listInstalled(claude);
  if (!installed) {
    return planned.length ? [{ id: "plugins:claude", pack: "engine", say: `Claude Code is not installed yet, so its plugins wait: ${planned.join(", ")}.`, repair: "apply" }] : [];
  }
  const missing = wanted.filter((id) => !installed.includes(id));
  const departed = outage ? [] : owned.claude.filter((id) => !planned.includes(id) && installed.includes(id));
  if (dryRun) {
    return [
      ...missing.map((id) => ({ id: `plugin:${id}`, pack: "engine", say: `The Claude plugin ${id} needs to be installed.`, repair: "apply" as const })),
      ...departed.map((id) => ({ id: `plugin:${id}`, pack: "engine", say: `The Claude plugin ${id} needs to be removed.`, repair: "apply" as const })),
    ];
  }
  const findings = await fetchMarketplaces(claude, missing, { ...officialMarketplaces, ...settings.marketplaces });
  const unreachable = findings.map((finding) => finding.id.slice("plugin-marketplace:".length));
  const next = new Set(owned.claude.filter((id) => installed.includes(id) || (outage && !planned.includes(id))));
  for (const id of missing.filter((id) => !unreachable.includes(marketplaceOf(id)))) {
    if ((await claude(["install", id, "--scope", "user"])).code === 0) next.add(id);
    else findings.push({ id: `plugin:${id}`, pack: "engine", say: `Could not install the Claude plugin ${id}.`, repair: "apply" });
  }
  for (const id of departed) {
    if ((await claude(["uninstall", id, "--scope", "user", "--keep-data"])).code === 0) next.delete(id);
    else findings.push({ id: `plugin:${id}`, pack: "engine", say: `Could not remove the Claude plugin ${id}.`, repair: "apply" });
  }
  const after = `${JSON.stringify({ claude: [...next].sort() }, null, 2)}\n`;
  if (after !== (text ?? `${JSON.stringify({ claude: [] }, null, 2)}\n`)) await writeWithBackups(home, [{ target: pluginsTarget, before: text, after }]);
  return findings;
}

export function declaredMarketplaces(settings: Document): Record<string, string> {
  const declared = get(settings, ["extraKnownMarketplaces"]);
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) return {};
  return Object.fromEntries(Object.entries(declared).flatMap(([name, entry]) => {
    const source = addSource((entry as { source?: unknown } | null)?.source);
    return source ? [[name, source]] : [];
  }));
}

const addSourceField: Record<string, string> = { github: "repo", git: "url", url: "url", directory: "path", file: "path" };

function addSource(source: unknown) {
  if (!source || typeof source !== "object") return undefined;
  const { source: kind, ...fields } = source as Record<string, unknown>;
  const field = typeof kind === "string" ? addSourceField[kind] : undefined;
  const value = field ? fields[field] : undefined;
  return Object.keys(fields).length === 1 && typeof value === "string" ? value : undefined;
}

async function fetchMarketplaces(claude: Claude, plugins: string[], sources: Record<string, string>): Promise<Finding[]> {
  const needed = [...new Set(plugins.map(marketplaceOf))];
  const fetched = needed.length ? await listMarketplaces(claude) : undefined;
  if (!fetched) return [];
  const findings: Finding[] = [];
  for (const name of needed) {
    if (fetched.includes(name)) {
      await claude(["marketplace", "update", name]);
      continue;
    }
    const source = sources[name];
    if (!source) continue;
    const added = await claude(["marketplace", "add", source, "--scope", "user"]);
    if (added.code === 0) continue;
    const waiting = plugins.filter((id) => marketplaceOf(id) === name).join(", ");
    findings.push({ id: `plugin-marketplace:${name}`, pack: "engine", say: `Could not add the Claude plugin marketplace ${name} from ${withoutCredentials(source)}: ${withoutCredentials(firstLine(added.stderr || added.stdout))}. Its plugins wait: ${waiting}.`, repair: "apply" });
  }
  return findings;
}

async function listMarketplaces(claude: Claude): Promise<string[] | undefined> {
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
const firstLine = (text: string) => text.trim().split("\n")[0]!.replace(/^✘\s*/, "").replace(/\.$/, "");

async function listInstalled(claude: Claude): Promise<string[] | undefined> {
  const result = await claude(["list", "--json"]);
  if (result.code !== 0) return undefined;
  const entries = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(entries)) throw new Error("Claude Code printed an unknown plugin list format");
  return entries.flatMap((entry) => (entry && typeof entry.id === "string" && entry.scope === "user" ? [entry.id as string] : []));
}

function parseOwned(text: string | undefined): Owned {
  if (text === undefined) return { claude: [] };
  const value = JSON.parse(text) as Owned;
  if (!Array.isArray(value?.claude) || value.claude.some((id) => typeof id !== "string")) throw new Error(`${pluginsTarget} is not a plugin record`);
  return value;
}
