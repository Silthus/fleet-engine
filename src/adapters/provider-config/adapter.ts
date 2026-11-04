import { join } from "node:path";
import { inside } from "../../files/install.ts";
import type { Action, Finding, Plan, Provider } from "../../pack/types.ts";
import type { Adapter, AdapterResult } from "../../reconciler/apply.ts";
import { spawnRunner, type CommandRunner } from "../run.ts";
import { codexHookTrust, isTrustOf } from "./codex-hooks.ts";
import { checkPath, get, json, keyPath, overlaps, remove, same, samePath, set, toml, type Document, type Field, type Format } from "./fields.ts";
import { reconcilePlugins } from "./plugins.ts";
import { staleKeys } from "./stale.ts";
import { linkOnPath, optional, readState, withLock, writeWithBackups, type Wait, type Write } from "./store.ts";

export type { CommandRunner } from "../run.ts";

/** owns says which of the provider's keys live in this file. sharedLock says its program takes <file>.lock before it writes the file. */
type Target = { provider: Provider; path: string; format: Format; owns(path: string[]): boolean; sharedLock?: true };
export type FieldRecord = { [target: string]: Field[] };
type Merged = { record: Field[]; kept: string[]; reason: string; after?: string; document: Document };
type FilesResult = AdapterResult & { plugins?: string[] };

export const recordTarget = ".config/fleet/provider-fields.json";
const isMcpServer = (path: string[]) => path[0] === "mcpServers";
const claudeSettings = ".claude/settings.json";

/** Claude Code reads user MCP servers from ~/.claude.json, next to state it keeps itself and writes under ~/.claude.json.lock, so Fleet owns only mcpServers.<name> there and takes the same lock. */
export const configTargets: Target[] = [
  { provider: "claude", path: claudeSettings, format: json, owns: (path) => !isMcpServer(path) },
  { provider: "claude", path: ".claude.json", format: json, owns: isMcpServer, sharedLock: true },
  { provider: "codex", path: ".codex/config.toml", format: toml, owns: () => true },
];

const ownedBy = (target: Target) => (entry: { provider: Provider; key: string }) => entry.provider === target.provider && target.owns(keyPath(entry.key));

export function providerConfigAdapter(options: { run?: CommandRunner; wait?: Wait } = {}): Adapter {
  const run = options.run ?? spawnRunner;
  const wait = options.wait ?? Bun.sleep;
  return {
    name: "config",
    targets: (plan) => configTargets.filter((target) => plan.config.some(ownedBy(target))).map((target) => target.path),
    async apply(plan, context) {
      const outage = sourceOutage(plan);
      const reconcile = async () => {
        const { plugins, ...result } = await reconcileFiles(plan, context.home, context.dryRun, context.adopt, outage, wait);
        result.findings.push(...(await reconcilePlugins(plan, context.home, context.dryRun, run, { outage, accepted: plugins })));
        return result;
      };
      const result = context.dryRun ? await reconcile() : await withLock(context.home, reconcile);
      if (outage) result.findings.push({ id: "config:outage", pack: "engine", say: "Kept every provider setting and plugin that Fleet would remove until all your pack sources can be fetched.", repair: "apply" });
      return result;
    },
  };
}

async function reconcileFiles(plan: Plan, home: string, dryRun: boolean, adopt: string[], outage: boolean, wait: Wait): Promise<FilesResult> {
  const previous = await readFieldRecord(home);
  const next: FieldRecord = {};
  const writes: Array<Write & { action: Action }> = [];
  const result: FilesResult = { actions: [], findings: [] };
  for (const target of configTargets) {
    const old = previous[target.path] ?? [];
    const keepOld = () => void (old.length && (next[target.path] = old));
    const before = await optional(inside(home, target.path));
    const link = await linkOnPath(home, target.path);
    const fields = owned(plan, target);
    let merged: Merged;
    try {
      merged = merge(target, before, old, fields, adopt.includes(target.path), { outage, configPath: join(home, target.path) });
    } catch (error) {
      keepOld();
      result.findings.push({ id: `kept:${target.path}`, pack: "engine", say: `Kept ${target.path} as it is: Fleet cannot read it (${(error as Error).message}). Fix the file, then run fleet apply.`, repair: "human" });
      continue;
    }
    if (merged.after !== undefined && link) {
      keepOld();
      result.findings.push({ id: `kept:${target.path}`, pack: "engine", say: `Kept ${target.path} because ${link === inside(home, target.path) ? "it is a link" : `${link} is a link`}. Fleet would ${merged.reason} there. Make it a plain file in a plain folder to let Fleet change it.` });
      continue;
    }
    if (merged.record.length) next[target.path] = merged.record;
    if (target.path === claudeSettings && !link) result.plugins = acceptedPlugins(merged.document);
    if (merged.kept.length) result.findings.push({ id: `kept:${target.path}`, pack: "engine", say: `Kept your ${merged.kept.join(", ")} in ${target.path}. Run fleet apply --adopt ${target.path} to take Fleet's value.` });
    if (merged.after !== undefined) writes.push({ target: target.path, before, after: merged.after, ...(target.sharedLock && { sharedLock: wait }), action: { target: target.path, operation: before === undefined ? "create" : "replace", reason: merged.reason } });
  }
  if (dryRun) {
    for (const write of writes) result.findings.push({ id: `config:${write.target}`, pack: "engine", say: `${write.target} needs an update: ${write.action.reason}.`, repair: "apply" });
    return result;
  }
  const recordText = `${JSON.stringify(next, null, 2)}\n`;
  const recordBefore = await readState(home, recordTarget);
  await writeWithBackups(home, recordBefore === recordText ? writes : [...writes, { target: recordTarget, before: recordBefore, after: recordText }]);
  result.actions.push(...writes.map((write) => write.action));
  return result;
}

function owned(plan: Plan, target: Target): Field[] {
  const fields = plan.config.filter(ownedBy(target)).map((entry) => ({ path: keyPath(entry.key), value: entry.value, pack: entry.pack }));
  fields.forEach((field, index) => {
    const other = fields.slice(index + 1).find((item) => overlaps(item.path, field.path));
    if (other) throw new Error(`${target.provider} keys ${field.path.join(".")} (${field.pack}) and ${other.path.join(".")} (${other.pack}) overlap. Each key owns its whole value, so a pack must own only one of them.`);
  });
  return fields;
}

function merge(target: Target, text: string | undefined, previous: Field[], wanted: Field[], adopt: boolean, options: { outage: boolean; configPath: string }): Merged {
  const current: Document = text === undefined ? {} : target.format.decode(text);
  const original = target.format.encode(current);
  const edited = previous.filter((field) => get(current, field.path) !== undefined && !same(get(current, field.path), field.value));
  const stale = options.outage ? [] : staleKeys(target.provider, current, (path) => target.owns(path) && !wanted.some((field) => overlaps(field.path, path)) && !edited.some((field) => overlaps(field.path, path)));
  const record: Field[] = [];
  const kept: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const reconcile = (fields: Field[]) => {
    const applied: Field[] = [];
    for (const field of fields) {
      const value = get(current, field.path);
      const old = previous.find((item) => samePath(item.path, field.path));
      if (!same(value, field.value) && value !== undefined && !(old && same(value, old.value)) && !adopt) {
        kept.push(field.path.join("."));
        if (old) record.push(old);
        continue;
      }
      if (!same(value, field.value)) {
        set(current, field.path, field.value);
        changed.push(field.path.join("."));
      }
      record.push(field);
      applied.push(field);
    }
    return applied;
  };
  const applied = reconcile(wanted);
  const trust: Field[] = [];
  const departed = previous.filter((field) => !wanted.some((item) => overlaps(item.path, field.path)) && !isHookTrust(field));
  const keepsEdit = (field: Field) => get(current, field.path) !== undefined && !same(get(current, field.path), field.value);
  if (target.provider === "codex") {
    const isEvent = (field: Field) => field.path[0] === "hooks" && field.path.length === 2;
    const keptEvents = [...wanted.filter((field) => isEvent(field) && !applied.includes(field)), ...departed.filter((field) => isEvent(field) && (options.outage || keepsEdit(field)))].map((field) => field.path[1]!);
    trust.push(...reconcile(codexHookTrust(applied, options.configPath)));
    const retained = previous.filter((field) => keptEvents.some((event) => isTrustOf(field, options.configPath, event)) && !trust.some((item) => samePath(item.path, field.path)));
    record.push(...retained);
    trust.push(...retained);
  }
  const all = [...wanted, ...trust];
  for (const field of previous) {
    if (all.some((item) => overlaps(item.path, field.path))) continue;
    if (options.outage || keepsEdit(field)) record.push(field);
    else if (get(current, field.path) !== undefined) {
      remove(current, field.path);
      removed.push(field.path.join("."));
    }
  }
  for (const path of stale) {
    if (get(current, path) === undefined) continue;
    remove(current, path);
    removed.push(path.join("."));
  }
  const reason = [changed.length ? `set ${changed.join(", ")}` : "", removed.length ? `remove ${removed.join(", ")}` : ""].filter(Boolean).join("; ");
  const after = target.format.encode(current);
  return { record, kept, reason, after: after === original ? undefined : after, document: current };
}

function acceptedPlugins(document: Document) {
  const enabled = get(document, ["enabledPlugins"]);
  return enabled && typeof enabled === "object" ? Object.entries(enabled).flatMap(([id, on]) => (on === true ? [id] : [])) : [];
}

const isHookTrust = (field: Field) => field.path[0] === "hooks" && field.path[1] === "state";

/** True while an enabled pack is missing because its source cannot be fetched. Its settings must not look departed. */
export function sourceOutage(plan: Plan) {
  return plan.packs.some((pack) => !pack.available && (pack.reason ?? "").startsWith("not found; unreachable"));
}

export async function readFieldRecord(home: string, target = recordTarget): Promise<FieldRecord> {
  const text = await readState(home, target);
  if (text === undefined) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${target} is not a field record`);
  const record: FieldRecord = {};
  for (const [file, fields] of Object.entries(value)) {
    if (!Array.isArray(fields) || fields.some((field) => !Array.isArray(field?.path) || field.path.some((key: unknown) => typeof key !== "string"))) throw new Error(`${target} holds an invalid field path`);
    for (const field of fields) checkPath(field.path, `${target} path ${field.path.join(".")}`);
    record[file] = fields;
  }
  return record;
}
