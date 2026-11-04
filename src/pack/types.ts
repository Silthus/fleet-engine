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

/** Limits an item to some machines, plans, or one workflow. An item without a field fits every value. */
export type Scope = { on?: Os[]; roles?: MachineRole[]; plans?: AiPlan[]; workflow?: string };

export type PackJob = Scope & {
  id: string;
  command: string[];
  schedule: { every: "5m" | "15m" | "1h" | "1d"; at?: string };
  runner?: "os" | "t3";
  task?: T3Task;
};

export type HumanStep = Scope & {
  id: string;
  say: string;
  command?: string;
  probe: string[];
};

export type PackStep = Scope & {
  id: string;
  run: string[];
  check?: string[];
  /** The id of a human step of the same pack that must pass before this step runs. */
  after?: string;
};

export type Provider = "claude" | "codex" | "t3";
export type ConfigEntry = Scope & { provider: Provider; key: string; value: unknown };

/** A file from the pack, linked at target under the home directory. */
export type PackFile = Scope & { path: string; target: string };

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** One row of the model table: the model and effort agents use for one kind of work. */
export type ModelRow = { role: string; work: string; provider: "claude" | "codex"; model: string; effort: Effort };

export type GuideEntry = { guide: string; section?: string; path: string };

export type PackManifest = {
  schema: 1;
  name: string;
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
  models?: Partial<Record<AiPlan, ModelRow[]>>;
};

export type PackCheck = Scope & { id: string; run: string[]; say: string };

export type SourceRef = { name: string; repo: string; ref: string };

export type LoadedPack = { manifest: PackManifest; dir: string };

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
  overrides?: { config?: ConfigEntry[]; skills?: string[]; models?: ModelRow[] };
};

export type Profile = ProfileFile & { dir: string; aboutMe?: string };

export type SetupProgress = { done: string[]; draft?: Partial<ProfileFile> };

export type MachineFile = { schema: 1; role: MachineRole; profileDir?: string; setup?: SetupProgress };

import type { Action, DesiredFile } from "../files/install.ts";

export type { Action, DesiredFile };

export type Owned<T> = T & { pack: string };

export type ResolvedPack = { name: string; source: string; ref: string; available: boolean; reason?: string };

export type Plan = {
  machine: MachineFile;
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
  commands: Record<string, { pack: string; path: string }>;
  models: ModelRow[];
  settings: Record<string, SettingValue>;
  unanswered: PackSetting[];
  ask: PackSetting[];
  dropped: Array<{ pack: string; item: string; reason: string }>;
};

export type Finding = { id: string; pack: string; say: string; repair?: "apply" | "human" };

export type Report = { ok: boolean; actions: Action[]; findings: Finding[]; humanLeft: HumanStep[] };
