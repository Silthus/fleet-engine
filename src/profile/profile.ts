import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MachineFile, PackManifest, Profile, ProfileFile } from "../pack/types.ts";
import { configEntryProblem, isModelRow } from "../pack/manifest.ts";

export class ProfileError extends Error {}

export async function loadProfile(dir: string): Promise<Profile> {
  const path = join(dir, "fleet.json");
  const file = await readJson(path);
  if (!file) throw new ProfileError(`${path}: missing`);
  const profile = checkProfile({ ...file, workflows: file.workflows ?? {}, settings: file.settings ?? {}, sources: file.sources ?? [] }, path);
  const aboutMe = Bun.file(join(dir, "about-me.md"));
  return { ...profile, dir, ...((await aboutMe.exists()) ? { aboutMe: await aboutMe.text() } : {}) };
}

/**
 * Saves answers to fleet.json and commits only that file. Settings merge key by
 * key; every other field, workflows included, replaces the saved one, so a
 * caller removes a workflow override by saving the full override set.
 */
export async function saveAnswers(dir: string, answers: Partial<ProfileFile>, options: { push?: boolean } = {}) {
  const path = join(dir, "fleet.json");
  const current = (await readJson(path)) ?? { schema: 1 };
  if (current.schema !== 1) throw new ProfileError(`${path}: unknown schema ${String(current.schema)}`);
  const settings = { ...(current.settings as Record<string, unknown> | undefined), ...answers.settings };
  await writeFile(path, JSON.stringify({ ...current, ...answers, settings, schema: 1 }, null, 2) + "\n");
  const added = await run(dir, "git", "add", "--", "fleet.json");
  if (!added.ok) throw new ProfileError(`${dir}: could not stage fleet.json: ${added.stderr}`);
  const changed = await run(dir, "git", "diff", "--cached", "--quiet", "--", "fleet.json");
  if (changed.code !== 0 && changed.code !== 1) throw new ProfileError(`${dir}: could not compare fleet.json: ${changed.stderr}`);
  if (changed.code === 1) {
    const committed = await run(dir, "git", "commit", "-q", "-m", "Save Fleet answers", "--", "fleet.json");
    if (!committed.ok) throw new ProfileError(`${dir}: could not commit answers: ${committed.stderr}`);
  }
  if (options.push && !(await run(dir, "git", "push", "-q")).ok) throw new ProfileError(`${dir}: could not push answers`);
}

export function workflowDefaults(packs: PackManifest[]): Record<string, boolean> {
  return Object.fromEntries(packs.flatMap((pack) => (pack.workflows ?? []).map((workflow) => [workflow.id, workflow.default])));
}

export function workflowOverrides(choices: Record<string, boolean>, packs: PackManifest[]): Record<string, boolean> {
  const defaults = workflowDefaults(packs);
  return Object.fromEntries(Object.entries(choices).filter(([id, on]) => id in defaults && defaults[id] !== on));
}

export function activeChoices(profile: Pick<ProfileFile, "workflows">, packs: PackManifest[]): Record<string, boolean> {
  return { ...workflowDefaults(packs), ...profile.workflows };
}

export function machinePath(home: string) {
  return join(home, ".config", "fleet", "machine.json");
}

export async function loadMachine(home: string): Promise<MachineFile | undefined> {
  const path = machinePath(home);
  const file = await readJson(path);
  if (!file) return undefined;
  return checkMachine(file, path);
}

export async function saveMachine(home: string, machine: MachineFile) {
  const path = machinePath(home);
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, JSON.stringify(machine, null, 2) + "\n");
  await rename(partial, path);
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as Record<string, unknown>) : undefined;
}

async function run(cwd: string, ...command: string[]) {
  const process = Bun.spawn(command, { cwd, env: { ...Bun.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() };
}

const aiPlans = ["claude", "codex", "both"];
const roles = ["mac", "devbox", "linux", "hub"];

function checkProfile(file: Record<string, unknown>, path: string): ProfileFile {
  const fail = (message: string): never => {
    throw new ProfileError(`${path}: ${message}`);
  };
  if (file.schema !== 1) fail(`unknown schema ${String(file.schema)}`);
  const engine = file.engine;
  if (!isRecord(engine) || typeof engine.repo !== "string" || typeof engine.ref !== "string" || (engine.channel !== "release" && engine.channel !== "track")) {
    fail("engine needs a repo, a ref, and a release or track channel");
  }
  if (!Array.isArray(file.packs) || !file.packs.every((pack) => typeof pack === "string")) fail("packs must list pack names");
  if (!aiPlans.includes(file.plan as string)) fail("plan must be claude, codex, or both");
  if (!Array.isArray(file.sources) || !file.sources.every((source) => isRecord(source) && ["name", "repo", "ref"].every((key) => typeof source[key] === "string"))) {
    fail("each source needs a name, a repo, and a ref");
  }
  if (!isRecord(file.settings) || !Object.values(file.settings).every((value) => ["string", "number", "boolean"].includes(typeof value))) fail("settings must map keys to text, numbers, or true and false");
  if (!isRecord(file.workflows) || !Object.values(file.workflows).every((value) => typeof value === "boolean")) fail("workflows must map ids to true or false");
  if (file.overrides !== undefined && !isRecord(file.overrides)) fail("overrides must be an object");
  const config = isRecord(file.overrides) ? file.overrides.config : undefined;
  if (config !== undefined && !Array.isArray(config)) fail("overrides.config must list config entries");
  ((config as unknown[] | undefined) ?? []).forEach((entry, index) => {
    const problem = configEntryProblem(entry);
    if (problem) fail(`overrides.config[${index}]: ${problem}`);
  });
  const models = isRecord(file.overrides) ? file.overrides.models : undefined;
  if (models !== undefined && !(Array.isArray(models) && models.every(isModelRow))) fail("overrides.models must list rows with a role, work, a claude or codex provider, a model, and an effort");
  return file as ProfileFile;
}

function checkMachine(file: Record<string, unknown>, path: string): MachineFile {
  const fail = (message: string): never => {
    throw new ProfileError(`${path}: ${message}`);
  };
  if (file.schema !== 1) fail(`unknown schema ${String(file.schema)}`);
  if (!roles.includes(file.role as string)) fail("role must be mac, devbox, linux, or hub");
  if (file.profileDir !== undefined && typeof file.profileDir !== "string") fail("profileDir must be a path");
  if (file.devboxes !== undefined && !(Array.isArray(file.devboxes) && file.devboxes.every((host) => typeof host === "string"))) fail("devboxes must list SSH hosts");
  const setup = file.setup;
  if (setup !== undefined && (!isRecord(setup) || !Array.isArray(setup.done) || !setup.done.every((step) => typeof step === "string") || (setup.draft !== undefined && !isRecord(setup.draft)))) {
    fail("setup needs a done list and an optional draft object");
  }
  return file as MachineFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
