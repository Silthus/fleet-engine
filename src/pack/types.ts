export type Os = "darwin" | "linux";
export type MachineRole = "mac" | "devbox" | "linux" | "hub";
export type AiPlan = "claude" | "codex" | "both";
export type Audience = "public" | "posthog";
export type SettingValue = string | number | boolean;

export const needValues = ["gh", "devbox", "always-on devbox", "hub", "coder", "posthog-org"] as const;
export type Need = (typeof needValues)[number];

export type Preset = { id: string; name: string; blurb: string; packs: string[]; workflows: Record<string, boolean> };
export type Concept = { word: string; note: string; audience?: Audience };

export type PackSetting = {
  key: string;
  question: string;
  type: "string" | "number" | "boolean" | "choice";
  default?: SettingValue;
  /** The answer setup preselects for a person by the machine's time zone, before default: the longest prefix of the zone wins, such as "Europe/" for Europe/Berlin. */
  defaultByTimeZone?: Record<string, SettingValue>;
  choices?: Array<{ value: SettingValue; label: string }>;
  optional?: true;
  ask?: "setup" | "never";
  secret?: false;
};

export type Workflow = {
  id: string;
  name: string;
  sentence: string;
  needs?: Need[];
  default: boolean;
  settings?: string[];
  moment?: { time: string; title: string; body: string; words?: string[]; night?: boolean };
  risk?: string;
};

/**
 * The payload of T3's scheduledTasks.upsert. The enclosing PackJob's id and
 * schedule are the task's: the Jobs adapter owns the task as fleet:<job id>
 * and maps { every, at } to T3's interval or fixed_time trigger.
 */
export type T3Task = {
  prompt: string;
  projectSetting: string;
  modelRole: string;
  workspaceStrategy: "worktree";
  runtimeMode: "full-access" | "auto" | "approval-required";
  /** Set by resolve from the projectSetting's value; packs leave it out. */
  project?: string;
};

/** Limits an item to some machines, plans, or one workflow. An item without a field fits every value. The role solo fits the only machine: it is not a devbox, the Hub pack is off, and the profile lists no devboxes. */
export type Scope = { on?: Os[]; roles?: Array<MachineRole | "solo">; plans?: AiPlan[]; workflow?: string };

export type TimerSchedule = { every: "5m" | "15m" | "1h" | "1d"; at?: string };

/** every always makes the job a service that runs all the time: a systemd user service on Linux, a launchd agent kept alive on a Mac. */
export type PackJob = Scope & {
  id: string;
  command: string[];
  schedule: TimerSchedule | { every: "always"; at?: undefined };
  runner?: "os" | "t3";
  task?: T3Task;
  after?: string;
};

export type HumanStep = Scope & {
  id: string;
  say: string;
  command?: string;
  probe: string[];
  /** The command reads the keyboard, such as a sign-in that asks to paste a code: it runs in the foreground with the terminal, and the probe runs once it ends. */
  interactive?: true;
  /** A command that Fleet runs during apply when the probe fails, before it probes again. */
  repair?: string[];
};

export type PackStep = Scope & {
  id: string;
  run: string[];
  check?: string[];
  /** The id of a human step of the same pack that must pass before this step runs. */
  after?: string;
};

/**
 * A T3 Code project script that runs when T3 makes a worktree of a project
 * whose folder matches one of projects: an absolute path or one under ~/,
 * where * stands for one folder name. The T3 adapter owns it as
 * fleet-<pack>-<id>.
 */
/** projectSetting names a setting whose value, a path, is one more project; resolve adds it to projects. */
export type T3ProjectScript = Scope & { id: string; name: string; command: string; projects: string[]; projectSetting?: string };

export type Provider = "claude" | "codex" | "t3";
/** after: the id of a human step or a check of the same pack that must pass before the entry is written. */
export type ConfigEntry = Scope & { provider: Provider; key: string; value: unknown; after?: string };

/** A service that every node reaches at 127.0.0.1:port; only a pack.ts declares one, because its credential is code. */
export type ServedService = Scope & { id: string; port: number; health: string; after?: string };

/** One entry of the service catalog, which every node computes from the same profile. */
export type CatalogEntry = { pack: string; id: string; port: number; health: string; after?: string };

/** A file from the pack, linked at target under the home directory. */
export type PackFile = Scope & { path: string; target: string };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** One row of the model table: the model and effort agents use for one kind of work. */
export type ModelRow = { role: string; work: string; provider: "claude" | "codex"; model: string; effort: Effort };

export type GuideEntry = { guide: string; section?: string; path: string };

export type PackManifest = {
  schema: 1;
  name: string;
  title?: string;
  summary: string;
  audience?: Audience;
  day?: string;
  cost?: string;
  risk?: string;
  requires?: string[];
  instructions?: string;
  guides?: GuideEntry[];
  skills?: string[];
  config?: ConfigEntry[];
  settings?: PackSetting[];
  workflows?: Workflow[];
  jobs?: PackJob[];
  human?: HumanStep[];
  steps?: PackStep[];
  checks?: PackCheck[];
  files?: PackFile[];
  t3ProjectScripts?: T3ProjectScript[];
  handlers?: PackHandler[];
  served?: ServedService[];
  models?: Partial<Record<AiPlan, ModelRow[]>>;
};

export type PackCheck = Scope & { id: string; run: string[]; say: string };

export const handlerSeams = ["review-bot"] as const;
export type HandlerSeam = (typeof handlerSeams)[number];

/** A script of the pack that a command of another pack hands its work to, such as the review bot behind fleet pr review. */
export type PackHandler = Scope & { seam: HandlerSeam; path: string };

export type SourceRef = { name: string; repo: string; ref: string };

export type PackCode = {
  settingKey(handle: unknown): string;
  serviceId(handle: unknown): string;
  repairs: Record<string, (ctx: Context) => Promise<void>>;
  commands: Record<string, (args: string[], ctx: Context) => Promise<number>>;
  services: Record<string, (ctx: Context) => Promise<void>>;
  credentials: Record<string, (ctx: Context, node: string) => Promise<string>>;
  checks: Record<string, (ctx: Context) => Promise<boolean>>;
};

export type LoadedPack = { manifest: PackManifest; dir: string; code?: PackCode };

export type AvailableSource = { ref: SourceRef; dir: string; packs: LoadedPack[]; stale?: string };

export type FetchedSource = AvailableSource | { ref: SourceRef; error: string };

export type ProfileFile = {
  schema: 1;
  engine: { repo: string; ref: string; channel: "release" | "track" };
  sources: SourceRef[];
  packs: string[];
  plan: AiPlan;
  settings: Record<string, SettingValue>;
  workflows: Record<string, boolean>;
  devboxes?: string[];
  /** The SSH name of the machine that runs the hub's items. */
  hub?: string;
  overrides?: { config?: ConfigEntry[]; skills?: string[]; models?: ModelRow[] };
};

export type Profile = ProfileFile & { dir: string; aboutMe?: string };

export type SetupProgress = { done: string[]; draft?: Partial<ProfileFile> };

/** coder: this machine is a Coder workspace. Saved once seen, because cron and services lack the Coder variables. name: this machine's SSH name, which the profile's hub names. */
export type MachineFile = { schema: 1; role: MachineRole; name?: string; coder?: true; profileDir?: string; devboxes?: string[]; setup?: SetupProgress };

import type { Action, DesiredFile } from "../files/install.ts";
import type { Context } from "../sdk/index.ts";

export type { Action, DesiredFile };

export type Owned<T> = T & { pack: string };

export type ResolvedPack = { name: string; source: string; ref: string; available: boolean; reason?: string };

export type Plan = {
  machine: MachineFile;
  /** The profile's hub, when it names one. */
  hub?: string;
  /** This machine runs the hub's items: it is the hub, or the only machine. */
  onHub?: boolean;
  /** The engine whose launcher a leading fleet in a pack's commands runs. */
  engineRoot?: string;
  os: Os;
  ai: AiPlan;
  packs: ResolvedPack[];
  workflows: Array<{ id: string; pack: string; active: boolean; reason?: string }>;
  files: DesiredFile[];
  config: Array<Owned<ConfigEntry>>;
  owners: Record<string, string>;
  jobs: Array<Owned<PackJob>>;
  human: Array<Owned<HumanStep>>;
  steps: Array<Owned<PackStep>>;
  checks: Array<Owned<PackCheck>>;
  /** Every served service of the profile, on every node, with its port. */
  catalog?: CatalogEntry[];
  t3ProjectScripts?: Array<Owned<T3ProjectScript>>;
  commands: Record<string, { pack: string; path: string }>;
  handlers: Partial<Record<HandlerSeam, { pack: string; path: string }>>;
  models: ModelRow[];
  settings: Record<string, SettingValue>;
  unanswered: PackSetting[];
  ask: PackSetting[];
  dropped: Array<{ pack: string; item: string; reason: string; check?: string }>;
};

export type Finding = { id: string; pack: string; say: string; repair?: "apply" | "human" };

export type Report = { ok: boolean; actions: Action[]; findings: Finding[]; humanLeft: HumanStep[] };
