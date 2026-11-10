import type { Fleet, Scope as SdkScope, Setting } from "../sdk/index.ts";
import type { HumanStep, PackCode, PackJob, PackSetting, Scope, Workflow } from "./types.ts";

type Declared = { kind: "setting" | "workflow" | "check" | "service"; id: string };

export function recordPack(exported: unknown): { manifest: Record<string, unknown>; code: PackCode } {
  if (!isPack(exported)) throw new Error("pack.ts must export default { sdk: 1, name, summary, register(fleet) }");
  const { register, sdk: _, ...fields } = exported;
  const declared = new Map<object, Declared>();
  const settings: PackSetting[] = [];
  const workflows: Workflow[] = [];
  const jobs: PackJob[] = [];
  const human: HumanStep[] = [];
  const declare = <T>(kind: Declared["kind"], id: string): T => {
    const handle = Object.freeze({});
    declared.set(handle, { kind, id });
    return handle as T;
  };
  const own = (handle: unknown, kind: Declared["kind"], label: string) => {
    const found = typeof handle === "object" && handle !== null ? declared.get(handle) : undefined;
    if (found?.kind !== kind) throw new Error(`${label} names a ${kind} that the ${fields.name} pack did not declare`);
    return found.id;
  };
  const code: PackCode = { settingKey: (handle) => own(handle, "setting", "ctx.get"), commands: Object.create(null), services: Object.create(null), checks: Object.create(null) };
  const place = (scope: SdkScope, label: string): Scope & { after?: string } => {
    if (scope.on !== undefined && scope.on !== "hub") throw new Error(`${label}: on takes only "hub"`);
    return {
      ...(scope.on === "hub" ? { roles: ["hub", "solo"] satisfies Scope["roles"] } : {}),
      ...(scope.os ? { on: [scope.os] } : {}),
      ...(scope.plans ? { plans: scope.plans } : {}),
      ...(scope.when ? { workflow: own(scope.when, "workflow", label) } : {}),
      ...(scope.after ? { after: own(scope.after, "check", label) } : {}),
    };
  };
  const runnable = (id: string, label: string) => {
    if (code.services[id] || code.checks[id]) throw new Error(`${label}: ${id} is declared twice`);
    return ["fleet", "run", `${fields.name}/${id}`];
  };

  const fleet: Fleet = {
    setting(def) {
      settings.push(def as PackSetting);
      return declare<Setting<never>>("setting", def.key);
    },
    workflow({ settings: handles, ...def }) {
      workflows.push({ ...def, ...(handles ? { settings: handles.map((handle) => own(handle, "setting", `workflow ${def.id}`)) } : {}) });
      return declare("workflow", def.id);
    },
    command(name, { run }) {
      if (code.commands[name]) throw new Error(`command ${name} is declared twice`);
      code.commands[name] = run;
    },
    service({ id, run, ...scope }) {
      jobs.push({ id, command: runnable(id, `service ${id}`), schedule: { every: "always" }, ...place(scope, `service ${id}`) });
      code.services[id] = run;
      return declare("service", id);
    },
    check({ id, say, test, repair, ...scope }) {
      if (scope.after) throw new Error(`check ${id}: a check cannot wait for another check`);
      if (repair?.command && /['"\\]/.test(repair.command)) throw new Error(`check ${id}: repair.command must be plain words, without quotes or backslashes, so Fleet knows it when you run it`);
      const ask = repair?.command ? say : [say, repair?.ask].filter(Boolean).join(" ");
      human.push({ id, say: ask, probe: runnable(id, `check ${id}`), ...(repair?.command ? { command: repair.command } : {}), ...(repair?.interactive ? { interactive: true as const } : {}), ...place(scope, `check ${id}`) });
      code.checks[id] = test;
      return declare("check", id);
    },
  };
  register(fleet);
  return { manifest: { schema: 1, ...fields, settings, workflows, jobs, human }, code };
}

function isPack(value: unknown): value is { sdk: 1; name: string; register(fleet: Fleet): void } & Record<string, unknown> {
  const pack = value as Record<string, unknown> | undefined;
  return typeof pack === "object" && pack !== null && pack.sdk === 1 && typeof pack.name === "string" && typeof pack.register === "function";
}
