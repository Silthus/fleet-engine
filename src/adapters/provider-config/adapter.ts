import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inside } from "../../files/install.ts";
import type { Action, Finding, Plan, Provider } from "../../pack/types.ts";
import type { Adapter, AdapterResult } from "../../reconciler/apply.ts";
import { codexHookTrust } from "./codex-hooks.ts";
import { get, json, remove, same, samePath, set, toml, type Document, type Field, type Format } from "./fields.ts";
import { reconcilePlugins } from "./plugins.ts";
import { staleKeys } from "./stale.ts";

export type CommandRunner = (command: string[]) => Promise<{ code: number; stdout: string }>;

type Target = { provider: Provider; path: string; format: Format };
type Record = { [target: string]: Field[] };
type Change = { target: string; before?: string; after: string; action: Action; kept: string[] };

export const recordTarget = ".config/fleet/provider-fields.json";
export const configTargets: Target[] = [
  { provider: "claude", path: ".claude/settings.json", format: json },
  { provider: "codex", path: ".codex/config.toml", format: toml },
];

export function providerConfigAdapter(options: { run?: CommandRunner } = {}): Adapter {
  const run = options.run ?? spawnRunner;
  return {
    name: "config",
    targets: (plan) => configTargets.filter((target) => plan.config.some((entry) => entry.provider === target.provider)).map((target) => target.path),
    async apply(plan, { home, dryRun, adopt }) {
      const previous = await readRecord(home);
      const next: Record = {};
      const changes: Change[] = [];
      const held: Finding[] = [];
      for (const target of configTargets) {
        const wanted = wantedFields(plan, target, home);
        const before = await optional(inside(home, target.path));
        let change: ReturnType<typeof merge>;
        try {
          change = merge(target, before, previous[target.path] ?? [], wanted, adopt.includes(target.path));
        } catch (error) {
          if (previous[target.path]) next[target.path] = previous[target.path]!;
          held.push({ id: `kept:${target.path}`, pack: "engine", say: `Kept ${target.path} as it is: Fleet cannot read it (${(error as Error).message}). Fix the file, then run fleet apply.`, repair: "human" });
          continue;
        }
        if (change.after !== undefined && (await isLink(inside(home, target.path)))) {
          if (previous[target.path]) next[target.path] = previous[target.path]!;
          held.push({ id: `kept:${target.path}`, pack: "engine", say: `Kept ${target.path} because it is a link. Fleet would ${change.reason} there. Make it a plain file to let Fleet change it.` });
          continue;
        }
        if (change.record.length) next[target.path] = change.record;
        if (change.after !== undefined) changes.push({ target: target.path, before, after: change.after, kept: change.kept, action: { target: target.path, operation: before === undefined ? "create" : "replace", reason: change.reason } });
        else if (change.kept.length) changes.push({ target: target.path, before, after: before ?? "", kept: change.kept, action: { target: target.path, operation: "keep" } });
      }
      const result: AdapterResult = { actions: [], findings: held };
      for (const change of changes.filter((item) => item.kept.length)) result.findings.push(keptFinding(change));
      const writes = changes.filter((change) => change.action.operation !== "keep");
      if (dryRun) {
        for (const change of writes) result.findings.push({ id: `config:${change.target}`, pack: "engine", say: `${change.target} needs an update: ${change.action.reason}.`, repair: "apply" });
      } else {
        const recordText = `${JSON.stringify(next, null, 2)}\n`;
        const recordBefore = await optional(inside(home, recordTarget));
        const all = recordBefore === recordText ? writes : [...writes, { target: recordTarget, before: recordBefore, after: recordText, kept: [], action: { target: recordTarget, operation: "replace" as const } }];
        await writeWithBackups(home, all);
        result.actions.push(...writes.map((change) => change.action));
      }
      result.findings.push(...(await reconcilePlugins(plan, home, dryRun, run)));
      return result;
    },
  };
}

function wantedFields(plan: Plan, target: Target, home: string): Field[] {
  const owned = plan.config.filter((entry) => entry.provider === target.provider).map((entry) => ({ path: entry.key.split("."), value: entry.value, pack: entry.pack }));
  return target.provider === "codex" ? [...owned, ...codexHookTrust(owned, join(home, target.path))] : owned;
}

function merge(target: Target, text: string | undefined, previous: Field[], wanted: Field[], adopt: boolean) {
  const current: Document = text === undefined ? {} : target.format.decode(text);
  const original = target.format.encode(current);
  const record: Field[] = [];
  const kept: string[] = [];
  const set_: string[] = [];
  const removed: string[] = [];
  for (const field of wanted) {
    const value = get(current, field.path);
    const old = previous.find((item) => samePath(item.path, field.path));
    if (same(value, field.value)) record.push(field);
    else if (value === undefined || (old && same(value, old.value)) || adopt) {
      set(current, field.path, field.value);
      set_.push(field.path.join("."));
      record.push(field);
    } else {
      kept.push(field.path.join("."));
      if (old) record.push(old);
    }
  }
  for (const field of previous) {
    if (wanted.some((item) => samePath(item.path, field.path))) continue;
    if (!same(get(current, field.path), field.value)) continue;
    remove(current, field.path);
    removed.push(field.path.join("."));
  }
  for (const path of staleKeys(target.provider, current, wanted)) {
    remove(current, path);
    removed.push(path.join("."));
  }
  const reason = [set_.length ? `set ${set_.join(", ")}` : "", removed.length ? `remove ${removed.join(", ")}` : ""].filter(Boolean).join("; ");
  const after = target.format.encode(current);
  return { record, kept, reason, after: after === original ? undefined : after };
}

function keptFinding(change: Change): Finding {
  return { id: `kept:${change.target}`, pack: "engine", say: `Kept your ${change.kept.join(", ")} in ${change.target}. Run fleet apply --adopt ${change.target} to take Fleet's value.` };
}

async function readRecord(home: string): Promise<Record> {
  const text = await optional(inside(home, recordTarget));
  if (text === undefined) return {};
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${recordTarget} is not a field record`);
  for (const fields of Object.values(value)) {
    if (!Array.isArray(fields) || fields.some((field) => !Array.isArray(field?.path) || !field.path.length || field.path.some((key: unknown) => typeof key !== "string"))) throw new Error(`${recordTarget} holds an invalid field path`);
  }
  return value as Record;
}

async function writeWithBackups(home: string, changes: Change[]) {
  const backupRoot = `.local/state/fleet/backups/${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const done: Change[] = [];
  try {
    for (const change of changes) {
      const path = inside(home, change.target);
      if (change.before !== undefined) {
        const backup = inside(home, `${backupRoot}/${change.target}`);
        await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
        await writeFile(backup, change.before, { mode: 0o600 });
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, change.after, { mode: 0o600 });
      await rename(temporary, path);
      done.push(change);
    }
  } catch (error) {
    for (const change of done.reverse()) {
      const path = inside(home, change.target);
      if (change.before === undefined) await rm(path, { force: true });
      else await writeFile(path, change.before);
    }
    throw error;
  }
}

async function isLink(path: string) {
  return lstat(path).then((info) => info.isSymbolicLink(), () => false);
}

async function optional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function spawnRunner(command: string[]) {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout };
  } catch {
    return { code: 127, stdout: "" };
  }
}
