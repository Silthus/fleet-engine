import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { MachineFile, PackManifest, Profile, ProfileFile } from "../pack/types.ts";
import { configEntryProblem, isModelRow } from "../pack/manifest.ts";
import { writePrivateFile } from "../files/private.ts";

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
  if (options.push) await push(dir);
}

export function bothChanged(dir: string, other: string) {
  return `${dir} and ${other} both have changes the other lacks.`;
}

async function push(dir: string) {
  const pushed = await run(dir, "git", "push", "-q");
  if (pushed.ok) return;
  const reason = pushed.stderr.split("\n").map((line) => withoutCredentials(line).replace(/\s+/g, " ").trim()).find((line) => line && !line.startsWith("To ") && !line.startsWith("hint:"));
  const behind = /\((fetch first|non-fast-forward)\)/.test(pushed.stderr);
  const recovery = behind ? ` ${bothChanged(dir, "its remote")} Run git -C ${dir} pull --rebase, then try again.` : reason ? " Fix that, then try again." : "";
  throw new ProfileError(`${dir}: could not push answers${reason ? `: ${reason.replace(/\.$/, "")}.` : "."}${recovery}`);
}

function withoutCredentials(line: string) {
  return line.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, (address) => {
    try {
      const url = new URL(address);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
    } catch {
      return "the remote";
    }
  });
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

export const validHost = (host: string) => /^[\w][\w.@-]*$/.test(host);

export function machinePath(home: string) {
  return join(home, ".config", "fleet", "machine.json");
}

export async function loadMachine(home: string): Promise<MachineFile | undefined> {
  const path = machinePath(home);
  const file = await readJson(path);
  if (!file) return undefined;
  return checkMachine(file, path);
}

/** Coder sets these in a workspace's login sessions and startup script. */
export function inCoderWorkspace(env: Record<string, string | undefined>) {
  return Boolean(env.CODER_AGENT_URL) || env.CODER === "true";
}

/** This machine as saved, or its defaults: a Mac, a devbox in a Coder workspace, or a Linux machine. A Coder workspace saved as linux becomes a devbox. Its name is the saved one, or the host name when that is an SSH name. */
export function thisMachine(saved: MachineFile | undefined, platform: NodeJS.Platform, env: Record<string, string | undefined>, host = hostname()): MachineFile {
  const coder = saved?.coder ?? (platform !== "darwin" && inCoderWorkspace(env) ? true : undefined);
  const fallback = platform === "darwin" ? "mac" : coder ? "devbox" : "linux";
  const role = !saved || (saved.role === "linux" && coder) ? fallback : saved.role;
  const name = saved?.name ?? (validHost(host) ? host : undefined);
  return { ...saved, schema: 1, role, ...(coder ? { coder } : {}), ...(name ? { name } : {}) };
}

/** A profile that names a hub decides the role: the machine it names is the hub, and a machine saved as the hub that it does not name is a devbox or a Linux machine again. */
export function placedMachine(machine: MachineFile, hub: string | undefined): MachineFile {
  if (hub === undefined) return machine;
  if (machine.name === hub) return { ...machine, role: "hub" };
  return machine.role === "hub" ? { ...machine, role: machine.coder ? "devbox" : "linux" } : machine;
}

export async function saveMachine(home: string, machine: MachineFile) {
  const path = machinePath(home);
  await mkdir(dirname(path), { recursive: true });
  await writePrivateFile(path, JSON.stringify(machine, null, 2) + "\n");
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
  if (file.hub !== undefined && !(typeof file.hub === "string" && validHost(file.hub))) fail("hub must be the SSH name of a machine");
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
  if (file.name !== undefined && !(typeof file.name === "string" && validHost(file.name))) fail("name must be this machine's SSH name");
  if (file.coder !== undefined && file.coder !== true) fail("coder must be true or left out");
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
