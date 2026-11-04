import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MachineFile, PackManifest, Profile, ProfileFile } from "../pack/types.ts";

export class ProfileError extends Error {}

export async function loadProfile(dir: string): Promise<Profile> {
  const path = join(dir, "fleet.json");
  const file = await readJson(path);
  if (!file) throw new ProfileError(`${path}: missing`);
  if (file.schema !== 1) throw new ProfileError(`${path}: unknown schema ${String(file.schema)}`);
  const loaded = file as Partial<ProfileFile>;
  const profile = { ...loaded, workflows: loaded.workflows ?? {}, settings: loaded.settings ?? {}, sources: loaded.sources ?? [] } as ProfileFile;
  const aboutMe = Bun.file(join(dir, "about-me.md"));
  return { ...profile, dir, ...((await aboutMe.exists()) ? { aboutMe: await aboutMe.text() } : {}) };
}

export async function saveAnswers(dir: string, answers: Partial<ProfileFile>, options: { push?: boolean } = {}) {
  const path = join(dir, "fleet.json");
  const current = (await readJson(path)) ?? {};
  await writeFile(path, JSON.stringify({ ...current, ...answers, schema: 1 }, null, 2) + "\n");
  await run(dir, "git", "add", "fleet.json");
  if ((await run(dir, "git", "diff", "--cached", "--quiet")).ok) return;
  const committed = await run(dir, "git", "commit", "-q", "-m", "Save Fleet answers");
  if (!committed.ok) throw new ProfileError(`${dir}: could not commit answers: ${committed.stderr}`);
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
  if (file.schema !== 1) throw new ProfileError(`${path}: unknown schema ${String(file.schema)}`);
  return file as MachineFile;
}

export async function saveMachine(home: string, machine: MachineFile) {
  const path = machinePath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(machine, null, 2) + "\n");
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as Record<string, unknown>) : undefined;
}

async function run(cwd: string, ...command: string[]) {
  const process = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  return { ok: code === 0, stderr: stderr.trim() };
}
