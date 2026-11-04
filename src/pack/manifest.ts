import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { needValues, type LoadedPack, type PackManifest } from "./types.ts";

export class PackError extends Error {}

const settingTypes = ["string", "number", "boolean", "choice"];
const packName = /^[a-z][a-z0-9-]*$/;

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
  for (const field of ["requires", "guides", "skills", "config", "settings", "workflows", "jobs", "human", "steps", "checks"]) {
    if (raw[field] !== undefined && !Array.isArray(raw[field])) fail(`${field} must be a list`);
  }
  const manifest = raw as PackManifest;
  checkSettings(manifest, fail);
  checkWorkflows(manifest, fail);
  return manifest;
}

function checkSettings(manifest: PackManifest, fail: (message: string) => never) {
  for (const setting of manifest.settings ?? []) {
    if (!setting.key?.startsWith(`${manifest.name}.`)) fail(`setting ${setting.key} must start with ${manifest.name}.`);
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
  const tied = { jobs: manifest.jobs, human: manifest.human, steps: manifest.steps, config: manifest.config };
  for (const [field, items] of Object.entries(tied)) {
    for (const item of items ?? []) {
      const label = "id" in item ? item.id : item.key;
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
