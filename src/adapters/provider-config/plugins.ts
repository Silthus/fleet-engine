import { withoutCredentials } from "../../credentials.ts";
import type { Finding, Plan } from "../../pack/types.ts";
import type { CommandRunner } from "../run.ts";
import { get, keyPath, type Document } from "./fields.ts";
import { readState, writeWithBackups } from "./store.ts";

export const pluginsTarget = ".config/fleet/provider-plugins.json";
const earlierTarget = ".config/fleet/plugins.json";
const pluginId = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/;

type CodexOwned = { id: string; version: string; enabled: boolean; pending?: true };
type ClaudeOwned = { id: string; enabled?: boolean };
type Owned = { claude: ClaudeOwned[]; codex: CodexOwned[] };
type Installed = { id: string; version: string; enabled: boolean };
type Claude = (args: string[]) => ReturnType<CommandRunner>;
type Codex = Claude;
type Sources = Record<string, string | null>;

const officialMarketplaces: Sources = { "claude-plugins-official": "anthropics/claude-plugins-official" };

export function wantedPlugins(plan: Plan) {
  return plan.config.flatMap((entry) => {
    const [root, id, ...rest] = keyPath(entry.key);
    if (entry.provider !== "claude" || root !== "enabledPlugins" || !id || rest.length || entry.value !== true) return [];
    if (!pluginId.test(id)) throw new Error(`${entry.pack} enables an invalid Claude plugin id: ${id}`);
    return [id];
  });
}

export function wantedCodexPlugins(plan: Plan) {
  return plan.config.flatMap((entry) => {
    const [root, id, field, ...rest] = keyPath(entry.key);
    if (entry.provider !== "codex" || root !== "plugins" || !id || field !== "enabled" || rest.length || entry.value !== true) return [];
    if (!pluginId.test(id)) throw new Error(`${entry.pack} enables an invalid Codex plugin id: ${id}`);
    return [id];
  });
}

type PluginSettings = { outage: boolean; accepted?: string[]; claudeEnabled?: Record<string, boolean>; marketplaces?: Sources; acceptedCodex?: string[] };

/**
 * Installs the plugins packs enable, through Claude Code and Codex in the given home. Removes only plugins that Fleet installed.
 * Reads the earlier Fleet's record, and never writes it: a plugin that Fleet installed becomes this Fleet's only once a pack enables it again.
 */
export async function reconcilePlugins(plan: Plan, home: string, dryRun: boolean, run: CommandRunner, settings: PluginSettings): Promise<Finding[]> {
  const text = await readState(home, pluginsTarget);
  const earlier = parseOwned(await readState(home, earlierTarget), earlierTarget);
  const record = adopt(parseOwned(text, pluginsTarget), earlier, { claude: wantedPlugins(plan), codex: wantedCodexPlugins(plan) });
  let saved = text;
  const save = async (next: Owned) => {
    const after = encodeOwned(next);
    if (dryRun || after === (saved ?? encodeOwned({ claude: [], codex: [] }))) return;
    await writeWithBackups(home, [{ target: pluginsTarget, before: saved, after }]);
    saved = after;
  };
  const claude = await reconcileClaude(plan, home, dryRun, run, settings, record.claude);
  if (claude.owned) await save({ ...record, claude: claude.owned });
  const owned = { ...record, ...(claude.owned ? { claude: claude.owned } : {}) };
  const codex = await reconcileCodex(plan, home, dryRun, run, settings, owned.codex, (next) => save({ ...owned, codex: next }));
  return [...claude.findings, ...codex];
}

async function reconcileClaude(plan: Plan, home: string, dryRun: boolean, run: CommandRunner, settings: PluginSettings, record: ClaudeOwned[]): Promise<{ findings: Finding[]; owned?: ClaudeOwned[] }> {
  const outage = settings.outage;
  const planned = wantedPlugins(plan);
  const owned = record.map((entry) => entry.id);
  const wanted = planned.filter((id) => settings.accepted?.includes(id));
  if (!planned.length && !owned.length) return { findings: [] };
  if (!settings.accepted) return { findings: planned.length ? [{ id: "plugins:claude", pack: "engine", say: `Claude plugins wait until Fleet can change .claude/settings.json: ${planned.join(", ")}.`, repair: "apply" }] : [] };
  const claude = (args: string[]) => run(["claude", "plugin", ...args], { home });
  const installed = await listInstalled(claude);
  if (!installed) {
    return { findings: planned.length ? [{ id: "plugins:claude", pack: "engine", say: `Claude Code is not installed yet, so its plugins wait: ${planned.join(", ")}.`, repair: "apply" }] : [] };
  }
  const missing = wanted.filter((id) => !installed.includes(id));
  const leaving = outage ? [] : record.filter((entry) => !planned.includes(entry.id) && installed.includes(entry.id));
  const changedOutside = (entry: ClaudeOwned) => entry.enabled !== undefined && settings.claudeEnabled?.[entry.id] !== undefined && settings.claudeEnabled[entry.id] !== entry.enabled;
  const released = leaving.filter(changedOutside).map((entry) => entry.id);
  const departed = leaving.map((entry) => entry.id).filter((id) => !released.includes(id));
  const releasedFindings = released.map((id) => ({ id: `plugin:${id}`, pack: "engine", say: `Kept the Claude plugin ${id}, which no pack enables any more, because it changed outside Fleet. It is yours now.` }));
  if (dryRun) {
    return { findings: [
      ...missing.map((id) => ({ id: `plugin:${id}`, pack: "engine", say: `The Claude plugin ${id} needs to be installed.`, repair: "apply" as const })),
      ...departed.map((id) => ({ id: `plugin:${id}`, pack: "engine", say: `The Claude plugin ${id} needs to be removed.`, repair: "apply" as const })),
      ...releasedFindings,
    ] };
  }
  const { findings, unreachable } = await fetchMarketplaces(claude, missing, { ...officialMarketplaces, ...settings.marketplaces });
  findings.push(...releasedFindings);
  const next = new Map(record.filter((entry) => !released.includes(entry.id) && (installed.includes(entry.id) || (outage && !planned.includes(entry.id)))).map((entry) => [entry.id, entry]));
  for (const id of missing.filter((id) => !unreachable.includes(marketplaceOf(id)))) {
    if ((await claude(["install", id, "--scope", "user"])).code === 0) next.set(id, { id, enabled: true });
    else findings.push({ id: `plugin:${id}`, pack: "engine", say: `Could not install the Claude plugin ${id}.`, repair: "apply" });
  }
  for (const id of departed) {
    if ((await claude(["uninstall", id, "--scope", "user", "--keep-data"])).code === 0) next.delete(id);
    else findings.push({ id: `plugin:${id}`, pack: "engine", say: `Could not remove the Claude plugin ${id}.`, repair: "apply" });
  }
  return { findings, owned: [...next.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

const codexFinding = (id: string, say: string): Finding => ({ id: `plugin:codex:${id}`, pack: "engine", say, repair: "apply" });

async function reconcileCodex(plan: Plan, home: string, dryRun: boolean, run: CommandRunner, settings: PluginSettings, owned: CodexOwned[], save: (next: CodexOwned[]) => Promise<void>): Promise<Finding[]> {
  const planned = wantedCodexPlugins(plan);
  if (!planned.length && !owned.length) return [];
  if (!settings.acceptedCodex) return planned.length ? [{ id: "plugins:codex", pack: "engine", say: `Codex plugins wait until Fleet can change .codex/config.toml: ${planned.join(", ")}.`, repair: "apply" }] : [];
  const wanted = planned.filter((id) => settings.acceptedCodex!.includes(id));
  const codex: Codex = (args) => run(["codex", "plugin", ...args], { home, clearEnv: ["CODEX_HOME"] });
  const installed = await listCodex(codex);
  if (!installed) return planned.length ? [{ id: "plugins:codex", pack: "engine", say: `Codex is not installed yet, so its plugins wait: ${planned.join(", ")}.`, repair: "apply" }] : [];
  const findings: Finding[] = [];
  const record = new Map(owned.map((entry) => [entry.id, entry]));
  const commit = () => save([...record.values()].sort((a, b) => a.id.localeCompare(b.id)));
  const present = (id: string) => installed.find((entry) => entry.id === id);
  const install = async (id: string) => {
    if (dryRun) return void findings.push(codexFinding(id, `The Codex plugin ${id} needs to be installed.`));
    record.set(id, { id, version: "", enabled: false, pending: true });
    await commit();
    const added = await codex(["add", id, "--json"]);
    const listed = await listCodex(codex);
    const after = listed?.find((entry) => entry.id === id);
    if (after) record.set(id, after);
    else if (listed) record.delete(id);
    await commit();
    if (added.code !== 0 || !after) findings.push(codexFinding(id, `Could not install the Codex plugin ${id}: ${added.code !== 0 ? reasonOf(added) : listed ? "Codex does not list it afterwards" : "Codex cannot list its plugins afterwards"}. Fleet tries again at the next apply.`));
  };
  for (const id of wanted) {
    const found = present(id);
    const mine = record.get(id);
    if (!found) {
      const twin = installed.find((entry) => nameOf(entry.id) === nameOf(id));
      if (twin) findings.push(codexFinding(id, `Did not install the Codex plugin ${id}: ${twin.id} is already installed under the same name. Remove one of them.`));
      else await install(id);
      continue;
    }
    if (!mine) continue;
    if (mine.pending) {
      record.set(id, found);
      continue;
    }
    if (found.enabled !== mine.enabled) {
      findings.push(codexFinding(id, `Kept the Codex plugin ${id} as you left it: it is ${found.enabled ? "enabled" : "disabled"} now, and Fleet installed it ${mine.enabled ? "enabled" : "disabled"}.`));
      continue;
    }
    if (found.version !== mine.version) record.set(id, { ...mine, version: found.version });
  }
  for (const mine of [...record.values()].filter((entry) => !planned.includes(entry.id))) {
    if (settings.outage) continue;
    const found = present(mine.id);
    if (!found) {
      if (!dryRun) record.delete(mine.id);
      continue;
    }
    if (!mine.pending && found.enabled !== mine.enabled) {
      findings.push(codexFinding(mine.id, `Kept the Codex plugin ${mine.id}, which no pack enables any more, because it changed outside Fleet. It is yours now.`));
      if (!dryRun) record.delete(mine.id);
      continue;
    }
    if (dryRun) {
      findings.push(codexFinding(mine.id, `The Codex plugin ${mine.id} needs to be removed.`));
      continue;
    }
    const removed = await codex(["remove", mine.id, "--json"]);
    if (removed.code === 0) record.delete(mine.id);
    else findings.push(codexFinding(mine.id, `Could not remove the Codex plugin ${mine.id}: ${reasonOf(removed)}.`));
  }
  await commit();
  return findings;
}

const nameOf = (id: string) => id.slice(0, id.indexOf("@"));

async function listCodex(codex: Codex): Promise<Installed[] | undefined> {
  const result = await codex(["list", "--json"]);
  if (result.code !== 0) return undefined;
  const entries = (JSON.parse(result.stdout) as { installed?: unknown })?.installed;
  if (!Array.isArray(entries)) throw new Error("Codex printed an unknown plugin list format");
  return entries.flatMap((entry) => {
    const value = entry as Record<string, unknown>;
    if (typeof value?.pluginId !== "string" || typeof value.version !== "string" || typeof value.enabled !== "boolean") throw new Error("Codex printed an unknown plugin list entry");
    return [{ id: value.pluginId, version: value.version, enabled: value.enabled }];
  });
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

async function fetchMarketplaces(claude: Claude, plugins: string[], sources: Sources): Promise<{ findings: Finding[]; unreachable: string[] }> {
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
const reasonOf = (result: { code: number; stdout: string; stderr?: string }) => withoutCredentials((result.stderr || result.stdout).trim().split("\n")[0]!.replace(/^✘\s*/, "").replace(/\.$/, "")) || `exit ${result.code}`;

async function listInstalled(claude: Claude): Promise<string[] | undefined> {
  const result = await claude(["list", "--json"]);
  if (result.code !== 0) return undefined;
  const entries = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(entries)) throw new Error("Claude Code printed an unknown plugin list format");
  return entries.flatMap((entry) => (entry && typeof entry.id === "string" && entry.scope === "user" ? [entry.id as string] : []));
}

function encodeOwned(owned: Owned): string {
  return `${JSON.stringify({ claude: owned.claude, ...(owned.codex.length ? { codex: owned.codex } : {}) }, null, 2)}\n`;
}

const isClaudeOwned = (entry: unknown): entry is ClaudeOwned | string => {
  if (typeof entry === "string") return pluginId.test(entry);
  const value = entry as Record<string, unknown>;
  return typeof value?.id === "string" && pluginId.test(value.id) && (value.enabled === undefined || typeof value.enabled === "boolean");
};
const claudeOwned = (entry: ClaudeOwned | string): ClaudeOwned => (typeof entry === "string" ? { id: entry, enabled: true } : { id: entry.id, ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }) });

const isCodexOwned = (entry: unknown): entry is CodexOwned => {
  const value = entry as Record<string, unknown>;
  return typeof value?.id === "string" && pluginId.test(value.id) && typeof value.version === "string" && typeof value.enabled === "boolean" && (value.pending === undefined || value.pending === true);
};

function parseOwned(text: string | undefined, target: string): Owned {
  if (text === undefined) return { claude: [], codex: [] };
  const value = JSON.parse(text) as { claude?: unknown; codex?: unknown; version?: unknown; installed?: unknown };
  const owned = value?.version === 1 && Array.isArray(value.installed) ? fromEarlierFleet(value.installed, target) : value;
  const codex = owned?.codex ?? [];
  const claude = owned?.claude;
  if (!Array.isArray(claude) || !claude.every(isClaudeOwned) || !Array.isArray(codex) || !codex.every(isCodexOwned)) throw new Error(`${target} is not a plugin record`);
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  const parsed = { claude: claude.map(claudeOwned), codex: codex.map(({ id, version, enabled, pending }) => ({ id, version, enabled, ...(pending ? { pending } : {}) })) };
  if (!unique(parsed.claude.map((entry) => entry.id)) || !unique(parsed.codex.map((entry) => entry.id))) throw new Error(`${target} is not a plugin record`);
  return parsed;
}

function adopt(owned: Owned, earlier: Owned, planned: { claude: string[]; codex: string[] }): Owned {
  const take = <Entry extends { id: string }>(mine: Entry[], theirs: Entry[], wanted: string[]) => [...mine, ...theirs.filter((entry) => wanted.includes(entry.id) && !mine.some((own) => own.id === entry.id))];
  return { claude: take(owned.claude, earlier.claude, planned.claude), codex: take(owned.codex, earlier.codex, planned.codex) };
}

function fromEarlierFleet(installed: unknown[], target: string): { claude: ClaudeOwned[]; codex: CodexOwned[] } {
  const entries = installed.map((entry) => entry as Record<string, unknown>);
  if (!entries.every((entry) => (entry?.provider === "claude" || entry?.provider === "codex") && isCodexOwned(entry))) throw new Error(`${target} is not a plugin record`);
  const of = (provider: string) => entries.filter((entry) => entry.provider === provider) as unknown as CodexOwned[];
  return {
    claude: of("claude").map(({ id, enabled, pending }) => ({ id, ...(pending ? {} : { enabled }) })),
    codex: of("codex"),
  };
}
