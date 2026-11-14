type Env = Record<string, string | undefined>;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelRow = { role: string; work: string; provider: "claude" | "codex"; model: string; effort: Effort };

const efforts = ["low", "medium", "high", "xhigh", "max"];

export function modelTable(env: Env = Bun.env): ModelRow[] {
  if (!env.FLEET_MODELS) throw new Error("run this command as fleet <command>, so it gets your model table");
  const rows = JSON.parse(env.FLEET_MODELS) as unknown;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error("FLEET_MODELS holds a malformed row");
  return rows;
}

export function modelFor(role: string, env: Env = Bun.env): ModelRow {
  const row = modelTable(env).find((candidate) => candidate.role === role);
  if (!row) throw new Error(`the model table of your AI plan has no ${role} row`);
  return row;
}

function isRow(value: unknown): value is ModelRow {
  const row = value as Partial<ModelRow>;
  return typeof row?.role === "string" && typeof row.model === "string" && typeof row.work === "string"
    && (row.provider === "claude" || row.provider === "codex") && efforts.includes(row.effort as string);
}

export function modelSessionEnv(env: Record<string, string | undefined>) {
  const { T3CODE_THREAD_ID: _lane, ...rest } = env;
  return rest;
}
