import type { Finding, Plan } from "../../pack/types.ts";
import type { AdapterResult } from "../../reconciler/apply.ts";
import { readFieldRecord, type FieldRecord } from "../provider-config/adapter.ts";
import { checkPath, json, type Document, type Field } from "../provider-config/fields.ts";
import { readState, writeWithBackups, type Write } from "../provider-config/store.ts";
import { holds, reconcileKeys, type Reconciled } from "./keys.ts";
import type { T3Rpc } from "./port.ts";

export const settingsTarget = ".t3/userdata/settings.json";
export const desktopTarget = ".t3/userdata/desktop-settings.json";
export const recordTarget = ".config/fleet/t3-settings.json";

type Options = { adopt: string[]; dryRun: boolean; outage: boolean; rpc?: T3Rpc };

const finding = (id: string, say: string, repair?: Finding["repair"]): Finding => ({ id, pack: "engine", say, ...(repair ? { repair } : {}) });

export function settingsFields(plan: Plan): Field[] {
  return plan.config.filter((entry) => entry.provider === "t3").map((entry) => ({ path: checkPath([entry.key], `t3 key ${entry.key}`), value: entry.value, pack: entry.pack }));
}

export function desktopFields(plan: Plan): Field[] {
  if (plan.os !== "darwin") return [];
  return [
    { path: ["updateChannel"], value: "nightly", pack: "engine" },
    { path: ["updateChannelConfiguredByUser"], value: true, pack: "engine" },
  ];
}

export async function readT3Settings(rpc: T3Rpc): Promise<Document> {
  return (await rpc.call<{ settings: Document }>("server.getConfig", {})).settings;
}

export async function reconcileSettings(plan: Plan, home: string, options: Options): Promise<AdapterResult> {
  const result: AdapterResult = { actions: [], findings: [] };
  const previous = await readFieldRecord(home, recordTarget);
  const next: FieldRecord = {};
  const writes: Array<Write & { reason: string }> = [];
  for (const [target, fields] of [[settingsTarget, settingsFields(plan)], [desktopTarget, desktopFields(plan)]] as const) {
    const old = previous[target] ?? [];
    let before: string | undefined;
    let current: Document;
    try {
      before = await readState(home, target);
      current = before === undefined ? {} : json.decode(before);
    } catch (error) {
      if (old.length) next[target] = old;
      result.findings.push(finding(`kept:${target}`, `Kept ${target} as it is: Fleet cannot read it (${(error as Error).message}). Fix the file, then run fleet apply.`, "human"));
      continue;
    }
    if (target === desktopTarget && current.updateChannelConfiguredByUser === true && current.updateChannel === undefined && !options.adopt.includes(target)) {
      if (old.length) next[target] = old;
      continue;
    }
    const adopt = options.adopt.includes(target) || (target === desktopTarget && current.updateChannelConfiguredByUser !== true);
    if (target === settingsTarget && options.rpc) {
      const effective = await readT3Settings(options.rpc);
      const merged = reconcileKeys(effectiveView(current, old, effective), old, fields, { adopt, outage: options.outage, matches: holds });
      keptFinding(target, merged, result);
      const refused = await throughServer(options.rpc, merged, effective, options.dryRun, result);
      const record = merged.record.flatMap((field) => (refused.includes(field) ? heldBefore(field, effective) : [field]));
      if (record.length) next[target] = record;
      continue;
    }
    const merged = reconcileKeys(current, old, fields, { adopt, outage: options.outage });
    keptFinding(target, merged, result);
    if (merged.record.length) next[target] = merged.record;
    const reason = [merged.changed.length ? `set ${merged.changed.join(", ")}` : "", merged.removed.length ? `remove ${merged.removed.join(", ")}` : ""].filter(Boolean).join("; ");
    if (reason) writes.push({ target, before, after: json.encode(merged.document), reason });
  }
  if (options.dryRun) {
    for (const write of writes) result.findings.push(finding(`t3:${write.target}`, `${write.target} needs an update: ${write.reason}.`, "apply"));
    return result;
  }
  const recordBefore = await readState(home, recordTarget);
  const recordText = `${JSON.stringify(next, null, 2)}\n`;
  const recordChanged = recordBefore !== recordText && !(recordBefore === undefined && !Object.keys(next).length);
  await writeWithBackups(home, recordChanged ? [...writes, { target: recordTarget, before: recordBefore, after: recordText }] : writes);
  result.actions.push(...writes.map((write) => ({ target: write.target, operation: write.before === undefined ? ("create" as const) : ("replace" as const), reason: write.reason })));
  return result;
}

function effectiveView(file: Document, old: Field[], effective: Document): Document {
  const keys = new Set([...Object.keys(file), ...old.map((field) => field.path[0]!)]);
  return Object.fromEntries([...keys].map((key) => [key, key in effective ? effective[key] : file[key]]).filter(([, value]) => value !== undefined));
}

function heldBefore(field: Field, effective: Document): Field[] {
  const value = effective[field.path[0]!];
  return value === undefined ? [] : [{ ...field, value }];
}

function keptFinding(target: string, merged: Reconciled, result: AdapterResult) {
  if (merged.kept.length) result.findings.push(finding(`kept:${target}`, `Kept your ${merged.kept.join(", ")} in ${target}. Run fleet apply --adopt ${target} to take Fleet's value.`));
}

async function throughServer(rpc: T3Rpc, merged: Reconciled, effective: Document, dryRun: boolean, result: AdapterResult): Promise<Field[]> {
  if (merged.removed.length) result.findings.push(finding("t3:dropped", `Fleet no longer sets ${merged.removed.join(", ")} in T3 Code. T3 Code keeps the current value; change it in T3 Code's settings if you like.`));
  const key = (field: Field) => field.path[0]!;
  const changed = merged.applied.filter((field) => !holds(effective[key(field)], field.value));
  if (!changed.length) return [];
  if (dryRun) return result.findings.push(finding("t3:settings", `T3 Code needs these settings: ${changed.map(key).join(", ")}.`, "apply")), [];
  await rpc.call("server.updateSettings", { patch: Object.fromEntries(changed.map((field) => [key(field), field.value])) });
  const after = await readT3Settings(rpc);
  const missing = changed.filter((field) => !holds(after[key(field)], field.value));
  const taken = changed.filter((field) => !missing.includes(field));
  if (taken.length) result.actions.push({ target: "t3 settings", operation: "replace", reason: `set ${taken.map(key).join(", ")}` });
  if (missing.length) result.findings.push(finding("t3:settings", `T3 Code did not take ${missing.map(key).join(", ")}. Run fleet apply again; if it stays, set it in T3 Code's settings.`, "apply"));
  return missing;
}
