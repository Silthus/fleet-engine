import type { AiPlan, Os, PackSetting, SettingValue, Workflow as WorkflowItem } from "../pack/types.ts";

declare const kind: unique symbol;
declare const valueType: unique symbol;

export type Value = SettingValue;
export type Setting<T extends Value = Value> = { readonly [kind]: "setting"; readonly [valueType]?: T };
export type Workflow = { readonly [kind]: "workflow" };
export type Check = { readonly [kind]: "check" };
export type Service = { readonly [kind]: "service" };

type ValueOf = { string: string; number: number; boolean: boolean; choice: Value };
type SettingType = keyof ValueOf;

export type SettingDef<K extends SettingType> = Omit<PackSetting, "type" | "default"> & { type: K; default?: ValueOf[K] };
export type WorkflowDef = Omit<WorkflowItem, "settings"> & { settings?: Setting[] };

export type Scope = { on?: "hub"; os?: Os; plans?: AiPlan[]; when?: Workflow; after?: Check };

export type Pack = {
  sdk: 1;
  name: string;
  summary: string;
  title?: string;
  day?: string;
  cost?: string;
  risk?: string;
  requires?: string[];
  register(fleet: Fleet): void;
};

/** on: "hub" runs the command on the hub, also when a person types it on another node. */
export type Command = { summary: string; on?: "hub"; run(args: string[], ctx: Context): Promise<number> };
export type Process = { run(ctx: Context): Promise<void> };
/** A service that every node reaches at http://127.0.0.1:<port>. credential returns the value for one node, by its SSH name. */
export type Serve = { port: number; health: string; credential(ctx: Context, node: string): Promise<string> };
export type ServiceDef = Scope & { id: string } & ((Process & { serve?: Serve }) | { serve: Serve; run?: undefined });
export type ConfigDef = Scope & { provider: "claude" | "codex" | "t3"; key: string; value: unknown };
/** command: a fleet command a person runs. run: a repair that Fleet runs during apply when the check fails. */
export type Repair = { ask: string; command?: string; interactive?: true; run?: never } | { run(ctx: Context): Promise<void>; ask?: string; command?: never; interactive?: never };
export type CheckDef = Scope & { id: string; say: string; test(ctx: Context): Promise<boolean>; repair?: Repair };

export type Fleet = {
  setting<K extends SettingType>(def: SettingDef<K>): Setting<ValueOf[K]>;
  workflow(def: WorkflowDef): Workflow;
  command(name: string, def: Command): void;
  service(def: ServiceDef): Service;
  check(def: CheckDef): Check;
  config(def: ConfigDef): void;
};

export type Secrets = { read(name: string): Promise<string | undefined>; write(name: string, value: string): Promise<void> };

export type Context = {
  get<T extends Value>(setting: Setting<T>): T;
  secrets: Secrets;
  stateDir: string;
  print(line: string): void;
  log(line: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  threads: Threads;
  /** The command's standard input. */
  stdin(): ReadableStream<Uint8Array>;
  /** The loopback URL of a served service of this pack and this machine's credential for it. Fails fast when either is missing. */
  use(service: Service): Promise<{ url: string; credential: string }>;
};

export type ThreadStart = { key: string; title: string; prompt: string; modelRole: string };
export type StartedThread = { id: string; url?: string };
export type Threads = { start(def: ThreadStart): Promise<StartedThread> };
