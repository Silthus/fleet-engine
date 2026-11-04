export type Os = "darwin" | "linux";
export type MachineRole = "mac" | "devbox" | "linux" | "hub";
export type AiPlan = "claude" | "codex" | "both";
export type Audience = "public" | "posthog";
export type SettingValue = string | number | boolean;

export const needValues = ["gh", "devbox", "always-on devbox", "hub", "coder", "posthog-org"] as const;
export type Need = (typeof needValues)[number];

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

export type T3Task = {
  id: string;
  prompt: string;
  projectSetting: string;
  modelRole: string;
  workspaceStrategy: "worktree";
  runtimeMode: "full-access" | "auto" | "approval-required";
  schedule: string;
};

export type PackJob = {
  id: string;
  command: string[];
  schedule: { every: "5m" | "15m" | "1h" | "1d"; at?: string };
  on?: Os[];
  roles?: MachineRole[];
  runner?: "os" | "t3";
  task?: T3Task;
  workflow?: string;
};

export type HumanStep = {
  id: string;
  say: string;
  command?: string;
  probe: string[];
  on?: Os[];
  roles?: MachineRole[];
  workflow?: string;
};

export type PackStep = {
  id: string;
  run: string[];
  check?: string[];
  on?: Os[];
  roles?: MachineRole[];
  workflow?: string;
};

export type Provider = "claude" | "codex" | "t3";
export type ConfigEntry = { provider: Provider; key: string; value: unknown; workflow?: string };

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
  checks?: Array<{ id: string; run: string[]; say: string; on?: Os[]; roles?: MachineRole[] }>;
};

export type SourceRef = { name: string; repo: string; ref: string };

export type LoadedPack = { manifest: PackManifest; dir: string };

export type FetchedSource =
  | { ref: SourceRef; dir: string; packs: LoadedPack[]; stale?: string }
  | { ref: SourceRef; error: string };

export type ProfileFile = {
  schema: 1;
  engine: { repo: string; ref: string; channel: "release" | "track" };
  sources: SourceRef[];
  packs: string[];
  plan: AiPlan;
  settings: Record<string, SettingValue>;
  workflows: Record<string, boolean>;
  overrides?: { config?: ConfigEntry[]; skills?: string[] };
};

export type Profile = ProfileFile & { dir: string; aboutMe?: string };

export type SetupProgress = { done: string[]; draft?: Partial<ProfileFile> };

export type MachineFile = { schema: 1; role: MachineRole; profileDir?: string; setup?: SetupProgress };
