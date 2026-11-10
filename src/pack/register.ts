import type { Fleet, Pack, Scope as SdkScope, Setting } from "../sdk/index.ts";
import type { ConfigEntry, HumanStep, PackCode, PackJob, PackSetting, Scope, ServedService, Workflow } from "./types.ts";

export const isSecretName = (name: string) => /^[a-z0-9][a-z0-9.-]*$/.test(name);

type Declared = { kind: "setting" | "workflow" | "check" | "service"; id: string };

export function recordPack(exported: unknown): { manifest: Record<string, unknown>; code: PackCode } {
  if (!isPack(exported)) throw new Error("pack.ts must export default { sdk: 1, name, summary, register(fleet) }");
  const { register: _register, sdk: _sdk, ...fields } = exported;
  const unnamed = Object.keys(fields).filter((key) => !packFields.includes(key));
  if (unnamed.length) throw new Error(`pack.ts has fields the SDK does not name: ${unnamed.join(", ")}`);
  const declared = new Map<object, Declared>();
  const settings: PackSetting[] = [];
  const workflows: Workflow[] = [];
  const jobs: PackJob[] = [];
  const human: HumanStep[] = [];
  const served: ServedService[] = [];
  const config: ConfigEntry[] = [];
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
  const code: PackCode = { settingKey: (handle) => own(handle, "setting", "ctx.get"), serviceId: (handle) => own(handle, "service", "ctx.use"), commands: Object.create(null), hubCommands: [], services: Object.create(null), checks: Object.create(null), credentials: Object.create(null), repairs: Object.create(null) };
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
    if (code.services[id] || code.checks[id] || code.credentials[id]) throw new Error(`${label}: ${id} is declared twice`);
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
    command(name, { run, on }) {
      if (code.commands[name]) throw new Error(`command ${name} is declared twice`);
      if (on !== undefined && on !== "hub") throw new Error(`command ${name}: on takes only "hub"`);
      code.commands[name] = run;
      if (on === "hub") code.hubCommands.push(name);
    },
    service({ id, run, serve, ...scope }) {
      const label = `service ${id}`;
      if (!run && !serve) throw new Error(`${label} needs run, serve, or both`);
      const command = runnable(id, label);
      if (serve) {
        if (scope.on !== "hub") throw new Error(`${label}: serve needs on: "hub"`);
        if (!isSecretName(id)) throw new Error(`${label}: a served service's id names its credential, so it is lowercase words joined by dashes or dots`);
        if (!Number.isInteger(serve.port) || serve.port < 1 || serve.port > 65535) throw new Error(`${label}: serve.port must be a port from 1 to 65535`);
        if (typeof serve.health !== "string" || !serve.health.startsWith("/")) throw new Error(`${label}: serve.health must be a path that starts with /`);
        if (typeof serve.credential !== "function") throw new Error(`${label}: serve.credential must be a function`);
        served.push({ id, port: serve.port, health: serve.health, ...place(scope, label) });
        code.credentials[id] = serve.credential;
      }
      if (run) {
        jobs.push({ id, command, schedule: { every: "always" }, ...place(scope, label) });
        code.services[id] = run;
      }
      return declare("service", id);
    },
    config({ provider, key, value, ...scope }) {
      config.push({ provider, key, value, ...place(scope, `config ${provider}:${key}`) });
    },
    check({ id, say, test, repair, ...scope }) {
      if (scope.after) throw new Error(`check ${id}: a check cannot wait for another check`);
      if (repair?.command && !/^fleet( [A-Za-z0-9._\/=:@-]+)+$/.test(repair.command)) throw new Error(`check ${id}: repair.command must be fleet and plain words of letters, digits, and . _ / = : @ -, with one space between words, so a shell passes it as written and Fleet knows it when you run it`);
      if (repair?.run && (repair.command || repair.interactive)) throw new Error(`check ${id}: a repair is a command a person runs or a run that Fleet runs, not both`);
      const ask = repair?.command ? say : [say, repair?.ask].filter(Boolean).join(" ");
      const probe = runnable(id, `check ${id}`);
      human.push({ id, say: ask, probe, ...(repair?.command ? { command: repair.command } : {}), ...(repair?.interactive ? { interactive: true as const } : {}), ...(repair?.run ? { repair: [...probe, "--repair"] } : {}), ...place(scope, `check ${id}`) });
      code.checks[id] = test;
      if (repair?.run) code.repairs[id] = repair.run;
      return declare("check", id);
    },
  };
  const registered: unknown = exported.register(fleet);
  if (registered instanceof Promise) {
    registered.catch(() => {});
    throw new Error("register returned a promise; declare everything before it returns");
  }
  return { manifest: { schema: 1, ...fields, settings, workflows, jobs, human, ...(served.length ? { served } : {}), ...(config.length ? { config } : {}) }, code };
}

const namedFields: Record<Exclude<keyof Pack, "sdk" | "register">, true> = { name: true, summary: true, title: true, day: true, cost: true, risk: true, requires: true };
const packFields = Object.keys(namedFields);

function isPack(value: unknown): value is { sdk: 1; name: string; register(fleet: Fleet): void } & Record<string, unknown> {
  const pack = value as Record<string, unknown> | undefined;
  return typeof pack === "object" && pack !== null && pack.sdk === 1 && typeof pack.name === "string" && typeof pack.register === "function";
}
