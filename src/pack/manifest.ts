import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { needValues, type LoadedPack, type ModelRow, type PackManifest } from "./types.ts";

export class PackError extends Error {}

const settingTypes = ["string", "number", "boolean", "choice"];
const packName = /^[a-z][a-z0-9-]*$/;

/** Settings the engine reads, which any pack may declare to set their default. */
export const engineSettings = ["identity.signer"];

export async function loadPacks(sourceDir: string): Promise<LoadedPack[]> {
  const root = join(sourceDir, "packs");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const packs: LoadedPack[] = [];
  for (const name of dirs) {
    const path = join(root, name, "pack.json");
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const manifest = parseManifest(await file.json(), path);
    if (manifest.name !== name) throw new PackError(`${path}: name ${manifest.name} does not match its directory ${name}`);
    packs.push({ manifest, dir: join(root, name) });
  }
  return packs;
}

export function parseManifest(raw: unknown, where: string): PackManifest {
  const fail = (message: string): never => {
    throw new PackError(`${where}: ${message}`);
  };
  if (!isRecord(raw)) return fail("not a JSON object");
  if (raw.schema !== 1) return fail(`unknown schema ${String(raw.schema)}`);
  if (typeof raw.name !== "string" || !packName.test(raw.name)) return fail("name must be lowercase words joined by dashes");
  if (typeof raw.summary !== "string" || raw.summary === "") return fail("summary must be one plain sentence");
  for (const field of ["requires", "guides", "skills", "config", "settings", "workflows", "jobs", "human", "steps", "checks", "files", "t3ProjectScripts"]) {
    if (raw[field] !== undefined && !Array.isArray(raw[field])) fail(`${field} must be a list`);
  }
  checkShapes(raw, fail);
  const manifest = raw as PackManifest;
  checkSettings(manifest, fail);
  checkWorkflows(manifest, fail);
  return manifest;
}

const oses = ["darwin", "linux"];
const roles = ["mac", "devbox", "linux", "hub"];
const intervals = ["5m", "15m", "1h", "1d"];
const runtimeModes = ["full-access", "auto", "approval-required"];
const providers = ["claude", "codex", "t3"];
const plans = ["claude", "codex", "both"];
const efforts = ["low", "medium", "high", "xhigh", "max"];

function scopeProblem(item: Record<string, unknown>) {
  if (item.on !== undefined && !isListOf(item.on, oses)) return "on must list darwin or linux";
  if (item.roles !== undefined && !isListOf(item.roles, roles)) return "roles must list mac, devbox, linux, or hub";
  if (item.plans !== undefined && !isListOf(item.plans, plans)) return "plans must list claude, codex, or both";
  if (item.workflow !== undefined && typeof item.workflow !== "string") return "workflow must be an id";
  return undefined;
}

/** What is wrong with a config entry from a pack or a profile's overrides, or undefined when it is sound. */
const t3ProjectKeys = ["projectSettingsOverrides", "projectScriptOverrides"];
const filled = (value: unknown) => typeof value === "string" && value.trim().length > 0;

export function configEntryProblem(item: unknown) {
  if (!isRecord(item)) return "must be an object";
  if (!providers.includes(item.provider as string) || typeof item.key !== "string") return "needs a provider and a key";
  if (item.provider === "t3" && t3ProjectKeys.includes(item.key)) return "T3 project settings hold Fleet's worktree scripts, so set those with t3ProjectScripts";
  if (item.provider === "claude" && item.key === "mcpServers") return "a Claude MCP server key names one server, such as mcpServers.<name>";
  if (item.provider === "claude" && item.key.startsWith("mcpServers.") && !isRecord(item.value)) return 'a Claude MCP server must be an object, such as { "type": "stdio", "command": ... }';
  return scopeProblem(item);
}

/** Checks every nested item's shape before the manifest is trusted as a PackManifest. */
function checkShapes(raw: Record<string, unknown>, fail: (message: string) => never) {
  const need = (ok: boolean, message: string) => {
    if (!ok) fail(message);
  };
  const each = (field: string, check: (item: Record<string, unknown>, label: string) => void) => {
    ((raw[field] as unknown[] | undefined) ?? []).forEach((item, index) => {
      if (!isRecord(item)) return fail(`${field}[${index}] must be an object`);
      const name = typeof item.id === "string" ? item.id : typeof item.key === "string" ? item.key : `[${index}]`;
      check(item, `${field} ${name}`);
    });
  };
  const filters = (item: Record<string, unknown>, label: string) => {
    const problem = scopeProblem(item);
    if (problem) fail(`${label}: ${problem}`);
  };
  for (const field of ["requires", "skills"]) need(raw[field] === undefined || isStrings(raw[field]), `${field} must list names`);
  need(raw.instructions === undefined || typeof raw.instructions === "string", "instructions must be a path");
  each("guides", (item, label) => {
    need(typeof item.guide === "string" && packName.test(item.guide), `${label}: guide must be lowercase words joined by dashes`);
    need(typeof item.path === "string", `${label}: path must be a path`);
    need(item.section === undefined || typeof item.section === "string", `${label}: section must be text`);
  });
  each("config", (item, label) => {
    const problem = configEntryProblem(item);
    if (problem) fail(`${label}: ${problem}`);
  });
  each("settings", (item, label) => {
    need(typeof item.key === "string" && typeof item.question === "string", `${label}: needs a key and a question`);
    const choices = item.choices;
    need(choices === undefined || (Array.isArray(choices) && choices.every((choice) => isRecord(choice) && isValue(choice.value) && typeof choice.label === "string")), `${label}: choices must list a value and a label each`);
    const fits = (value: unknown) => (item.type === "choice" ? ((choices as Array<{ value: unknown }> | undefined) ?? []).some((choice) => choice.value === value) : typeof value === item.type);
    need(item.default === undefined || fits(item.default), `${label}: default does not fit type ${String(item.type)}`);
    const zones = item.defaultByTimeZone;
    need(zones === undefined || (isRecord(zones) && Object.values(zones).every(fits)), `${label}: defaultByTimeZone must map time-zone prefixes to values that fit type ${String(item.type)}`);
    need(zones === undefined || item.ask === "setup", `${label}: defaultByTimeZone needs ask setup, because only setup reads it`);
  });
  each("workflows", (item, label) => {
    need(typeof item.name === "string" && typeof item.sentence === "string", `${label}: needs a name and a sentence`);
    need(item.needs === undefined || isStrings(item.needs), `${label}: needs must list needs`);
    need(item.settings === undefined || isStrings(item.settings), `${label}: settings must list keys`);
  });
  each("jobs", (item, label) => {
    need(typeof item.id === "string" && isStrings(item.command), `${label}: needs an id and a command list`);
    const schedule = isRecord(item.schedule) ? item.schedule : undefined;
    need(intervals.includes(schedule?.every as string), `${label}: schedule.every must be 5m, 15m, 1h, or 1d`);
    need(schedule?.at === undefined || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule.at)), `${label}: schedule.at must be HH:MM`);
    need(item.runner === undefined || item.runner === "os" || item.runner === "t3", `${label}: runner must be os or t3`);
    filters(item, label);
    if (item.task === undefined) return;
    const task = isRecord(item.task) ? item.task : fail(`${label}: task must be an object`);
    need(["prompt", "projectSetting", "modelRole"].every((key) => typeof task[key] === "string"), `${label}: task needs a prompt, a projectSetting, and a modelRole`);
    need(task.workspaceStrategy === "worktree", `${label}: task.workspaceStrategy must be worktree`);
    need(runtimeModes.includes(task.runtimeMode as string), `${label}: task.runtimeMode must be full-access, auto, or approval-required`);
    need(task.id === undefined && task.schedule === undefined, `${label}: the job's id and schedule are the task's; drop task.id and task.schedule`);
  });
  each("files", (item, label) => {
    need(typeof item.path === "string" && typeof item.target === "string", `${label}: needs a path and a target`);
    filters(item, label);
  });
  checkModels(raw.models, fail);
  each("human", (item, label) => {
    need(typeof item.id === "string" && typeof item.say === "string" && isStrings(item.probe), `${label}: needs an id, a say, and a probe list`);
    need(item.command === undefined || typeof item.command === "string", `${label}: command must be text`);
    need(item.interactive === undefined || item.interactive === true, `${label}: interactive must be true when set`);
    need(item.interactive === undefined || item.command !== undefined, `${label}: interactive needs a command to run`);
    filters(item, label);
  });
  each("steps", (item, label) => {
    need(typeof item.id === "string" && isStrings(item.run), `${label}: needs an id and a run list`);
    need(item.check === undefined || isStrings(item.check), `${label}: check must be a command list`);
    const human = Array.isArray(raw.human) ? (raw.human as Array<Record<string, unknown>>) : [];
    const waited = human.find((step) => step.id === item.after);
    need(item.after === undefined || (typeof item.after === "string" && waited !== undefined), `${label}: after must name a human step of this pack`);
    for (const scope of ["on", "roles", "plans", "workflow"]) {
      const wider = waited?.[scope] !== undefined && (Array.isArray(waited[scope]) ? !(Array.isArray(item[scope]) && (item[scope] as unknown[]).every((value) => (waited[scope] as unknown[]).includes(value))) : item[scope] !== waited[scope]);
      need(!wider, `${label}: runs where its human step ${String(item.after)} does not; give it the same ${scope}`);
    }
    filters(item, label);
  });
  each("t3ProjectScripts", (item, label) => {
    need(typeof item.id === "string" && filled(item.name) && filled(item.command) && isStrings(item.projects) && item.projects.length > 0, `${label}: needs an id, a name, a command, and a projects list`);
    need(packName.test(item.id as string), `${label}: id must be lowercase words joined by dashes`);
    need((item.projects as string[]).every((path) => path.startsWith("/") || path.startsWith("~/")), `${label}: each project must be an absolute path or start with ~/`);
    filters(item, label);
  });
  each("checks", (item, label) => {
    need(typeof item.id === "string" && isStrings(item.run) && typeof item.say === "string", `${label}: needs an id, a run list, and a say`);
    filters(item, label);
  });
}

function checkModels(models: unknown, fail: (message: string) => never) {
  if (models === undefined) return;
  if (!isRecord(models) || !Object.keys(models).every((plan) => plans.includes(plan))) fail("models must map claude, codex, or both to rows");
  for (const [plan, rows] of Object.entries(models as Record<string, unknown>)) {
    if (!Array.isArray(rows)) fail(`models ${plan} must list rows`);
    const roles = new Set<string>();
    for (const row of rows as unknown[]) {
      if (!isModelRow(row)) fail(`models ${plan}: each row needs a role, work, a claude or codex provider, a model, and an effort`);
      const { role } = row as ModelRow;
      if (roles.has(role)) fail(`models ${plan}: role ${role} is listed twice`);
      roles.add(role);
    }
  }
}

export function isModelRow(row: unknown): row is ModelRow {
  return isRecord(row) && ["role", "work", "model"].every((key) => typeof row[key] === "string") && (row.provider === "claude" || row.provider === "codex") && efforts.includes(row.effort as string);
}

function checkSettings(manifest: PackManifest, fail: (message: string) => never) {
  for (const setting of manifest.settings ?? []) {
    if (!setting.key?.startsWith(`${manifest.name}.`) && !engineSettings.includes(setting.key)) fail(`setting ${setting.key} must start with ${manifest.name}.`);
    if (!settingTypes.includes(setting.type)) fail(`setting ${setting.key} has unknown type ${setting.type}`);
    if (setting.type === "choice" && !setting.choices?.length) fail(`setting ${setting.key} is a choice without choices`);
  }
}

function checkWorkflows(manifest: PackManifest, fail: (message: string) => never) {
  const ids = new Set<string>();
  for (const workflow of manifest.workflows ?? []) {
    if (typeof workflow.id !== "string" || typeof workflow.default !== "boolean") fail("each workflow needs an id and a boolean default");
    if (ids.has(workflow.id)) fail(`workflow ${workflow.id} is declared twice`);
    ids.add(workflow.id);
    for (const need of workflow.needs ?? []) {
      if (!(needValues as readonly string[]).includes(need)) fail(`workflow ${workflow.id} has unknown need ${need}`);
    }
  }
  const tied = { jobs: manifest.jobs, human: manifest.human, steps: manifest.steps, checks: manifest.checks, config: manifest.config, files: manifest.files, t3ProjectScripts: manifest.t3ProjectScripts };
  for (const [field, items] of Object.entries(tied)) {
    for (const item of items ?? []) {
      const label = "id" in item ? item.id : "key" in item ? item.key : item.target;
      if (item.workflow !== undefined && !ids.has(item.workflow)) fail(`${field} ${label} names unknown workflow ${item.workflow}`);
    }
  }
  for (const job of manifest.jobs ?? []) {
    if (job.runner === "t3" && !job.task) fail(`job ${job.id} runs on t3 but has no task`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isListOf(value: unknown, allowed: string[]) {
  return isStrings(value) && value.every((item) => allowed.includes(item));
}

function isValue(value: unknown) {
  return ["string", "number", "boolean"].includes(typeof value);
}
