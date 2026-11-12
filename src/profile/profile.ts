import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MachineFile, PackManifest, Profile, ProfileFile, SourceRef } from "../pack/types.ts";
import { configEntryProblem, isModelRow } from "../pack/manifest.ts";
import { sourceName } from "../pack/sources.ts";
import { withoutCredentials } from "../credentials.ts";
import { writePrivateFile } from "../files/private.ts";
import { isKeptForBoxes } from "../hub/names.ts";

export class ProfileError extends Error {}

export async function loadProfile(dir: string): Promise<Profile> {
  const path = join(dir, "fleet.json");
  const file = await readJson(path);
  if (!file) throw new ProfileError(`${path}: missing`);
  const profile = checkProfile({ ...file, workflows: file.workflows ?? {}, settings: file.settings ?? {}, sources: file.sources ?? [] }, path);
  const aboutMe = Bun.file(join(dir, "about-me.md"));
  return { ...profile, dir, ...((await aboutMe.exists()) ? { aboutMe: await aboutMe.text() } : {}) };
}

/** Takes what other machines pushed before a change here, so the change lands on top of theirs. A profile without a remote has nothing to take. */
export async function pullProfile(dir: string) {
  if (!(await run(dir, "git", "rev-parse", "--abbrev-ref", "@{upstream}")).ok) return;
  const pulled = await run(dir, "git", "pull", "-q", "--rebase", "--no-autostash");
  if (pulled.ok) return;
  const failed = `${dir}: could not take the changes another machine pushed`;
  if (await rebasing(dir)) {
    await run(dir, "git", "rebase", "--abort");
    throw new ProfileError(`${failed}. ${bothChanged(dir, "its remote")} Run git -C ${dir} pull --rebase, then try again.`);
  }
  if ((await run(dir, "git", "status", "--porcelain")).stdout) throw new ProfileError(`${failed}, because ${dir} has changes that are not committed. Commit or discard them, then try again.`);
  const reason = gitReason(pulled.stderr);
  throw new ProfileError(`${failed}${reason ? `: ${reason}. Fix that, then try again.` : "."}`);
}

async function rebasing(dir: string) {
  const paths = await run(dir, "git", "rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply");
  return paths.stdout.split("\n").some((path) => existsSync(resolve(dir, path)));
}

/**
 * Saves answers to fleet.json and commits only that file. Settings merge key by
 * key; every other field, workflows included, replaces the saved one, so a
 * caller removes a workflow override by saving the full override set.
 */
export async function saveAnswers(dir: string, answers: Partial<ProfileFile>, options: { push?: boolean } = {}) {
  const path = join(dir, "fleet.json");
  if (options.push) await pullUnder(dir, path, answers);
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

async function pullUnder(dir: string, path: string, answers: Partial<ProfileFile>) {
  const before = await readJson(path);
  await pullProfile(dir);
  const after = await readJson(path);
  const changed = Object.keys(answers).filter((key) => key !== "settings" && JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
  if (changed.length) throw new ProfileError(`${dir}: another machine changed ${changed.join(" and ")} in your profile while this command ran. Run the command again to change them on top of that.`);
}

export function bothChanged(dir: string, other: string) {
  return `${dir} and ${other} both have changes the other lacks.`;
}

async function push(dir: string) {
  const pushed = await run(dir, "git", "push", "-q");
  if (pushed.ok) return;
  const reason = gitReason(pushed.stderr);
  const behind = /\((fetch first|non-fast-forward)\)/.test(pushed.stderr);
  const recovery = behind ? ` ${bothChanged(dir, "its remote")} Run git -C ${dir} pull --rebase, then try again.` : reason ? " Fix that, then try again." : "";
  throw new ProfileError(`${dir}: could not push answers${reason ? `: ${reason}.` : "."}${recovery}`);
}

function gitReason(stderr: string) {
  const line = stderr.split("\n").map((text) => withoutCredentials(text).replace(/\s+/g, " ").trim()).find((text) => text && !text.startsWith("To ") && !text.startsWith("hint:"));
  return line?.replace(/\.$/, "");
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

/** The SSH name coder config-ssh gives a workspace, which every machine reaches it by. A box from the pool keeps its bare name. */
export function coderSshName(env: Record<string, string | undefined>): string | undefined {
  const workspace = env.CODER_WORKSPACE_NAME;
  return workspace && validHost(workspace) && !isKeptForBoxes(workspace) ? `coder.${workspace}` : undefined;
}

/** This machine as saved, or its defaults: a Mac, a devbox in a Coder workspace, or a Linux machine. A Coder workspace saved as linux becomes a devbox. Its name is the saved one, then its Coder SSH name, then the host name when that is an SSH name. */
export function thisMachine(saved: MachineFile | undefined, platform: NodeJS.Platform, env: Record<string, string | undefined>, host = hostname()): MachineFile {
  const coder = saved?.coder ?? (platform !== "darwin" && inCoderWorkspace(env) ? true : undefined);
  const fallback = platform === "darwin" ? "mac" : coder ? "devbox" : "linux";
  const role = !saved || (saved.role === "linux" && coder) ? fallback : saved.role;
  const name = saved?.name ?? (coder ? coderSshName(env) : undefined) ?? (validHost(host) ? host : undefined);
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
  for (const source of file.sources as SourceRef[]) {
    if (!sourceName.test(source.name)) fail(`source name ${JSON.stringify(source.name)} must be lowercase words joined by dashes`);
    if (source.repo.startsWith("-") || source.ref.startsWith("-")) fail(`source ${source.name}: repo and ref must not start with -`);
  }
  if (!isRecord(file.settings) || !Object.values(file.settings).every((value) => ["string", "number", "boolean"].includes(typeof value))) fail("settings must map keys to text, numbers, or true and false");
  if (!isRecord(file.workflows) || !Object.values(file.workflows).every((value) => typeof value === "boolean")) fail("workflows must map ids to true or false");
  if (file.hub !== undefined && !(typeof file.hub === "string" && validHost(file.hub))) fail("hub must be the SSH name of a machine");
  if (file.overrides !== undefined && !isRecord(file.overrides)) fail("overrides must be an object");
  const config = isRecord(file.overrides) ? file.overrides.config : undefined;
  if (config !== undefined && !Array.isArray(config)) fail("overrides.config must list config entries");
  ((config as unknown[] | undefined) ?? []).forEach((entry, index) => {
    const problem = isRecord(entry) && entry.after !== undefined ? "after names a pack's check, so only a pack's own config item can wait for one" : configEntryProblem(entry);
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
  if (file.t3Environments !== undefined && !(isRecord(file.t3Environments) && Object.values(file.t3Environments).every((id) => typeof id === "string"))) fail("t3Environments must map SSH hosts to T3 environment ids");
  const setup = file.setup;
  if (setup !== undefined && (!isRecord(setup) || !Array.isArray(setup.done) || !setup.done.every((step) => typeof step === "string") || (setup.draft !== undefined && !isRecord(setup.draft)))) {
    fail("setup needs a done list and an optional draft object");
  }
  return file as MachineFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
