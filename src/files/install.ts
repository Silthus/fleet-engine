import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// A conflict note explains what an unmanaged existing file loses when Fleet adopts it.
export type DesiredFile = { target: string; conflict?: string } & ({ source: string } | { content: string });
type RecordEntry = { kind: "link"; source: string } | { kind: "file"; hash: string };
type State = { version: 1; groups: Record<string, Record<string, RecordEntry>> };
export type Action = { target: string; operation: "create" | "keep" | "replace" | "remove" | "conflict"; reason?: string };
const statePath = ".local/state/fleet/state.json";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function inside(root: string, path: string): string {
  if (!path || isAbsolute(path)) throw new Error(`Expected a relative path: ${path}`);
  const full = resolve(root, path);
  const rel = relative(resolve(root), full);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Path leaves its root: ${path}`);
  if (rel !== path) throw new Error(`Use a normalized relative path: ${path}`);
  return full;
}

async function stat(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Do not follow directory links when writing configuration or ownership records.
export async function checkParents(home: string, target: string) {
  let parent = dirname(inside(home, target));
  while (parent !== resolve(home)) {
    const info = await stat(parent);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Parent is not a real directory: ${parent}`);
    parent = dirname(parent);
  }
}

async function readState(home: string): Promise<State> {
  await checkParents(home, statePath);
  const path = inside(home, statePath);
  const info = await stat(path);
  if (!info) return { version: 1, groups: {} };
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Fleet state must be a regular file");
  const value = JSON.parse(await readFile(path, "utf8")) as State;
  if (value.version !== 1 || !value.groups || typeof value.groups !== "object") throw new Error("Invalid Fleet state");
  for (const entries of Object.values(value.groups)) {
    if (!entries || typeof entries !== "object") throw new Error("Invalid Fleet group");
    for (const [target, entry] of Object.entries(entries)) {
      inside(home, target);
      if (!entry || (entry.kind !== "link" && entry.kind !== "file")) throw new Error("Invalid Fleet ownership entry");
      if (entry.kind === "link" ? typeof entry.source !== "string" : typeof entry.hash !== "string") throw new Error("Invalid Fleet ownership value");
    }
  }
  return value;
}

async function matches(path: string, entry: RecordEntry): Promise<boolean> {
  const info = await stat(path);
  if (!info) return false;
  if (entry.kind === "link") return info.isSymbolicLink() && resolve(dirname(path), await readlink(path)) === entry.source;
  return info.isFile() && !info.isSymbolicLink() && digest(await readFile(path, "utf8")) === entry.hash;
}

function record(file: DesiredFile): RecordEntry {
  return "source" in file ? { kind: "link", source: resolve(file.source) } : { kind: "file", hash: digest(file.content) };
}

// Skipped targets leave the group: Fleet neither writes nor tracks them.
// Held targets stay in the group as they are: Fleet neither writes nor forgets them.
export async function plan(home: string, files: DesiredFile[], group = "core", adopt: string[] = [], skip: string[] = [], hold: string[] = []): Promise<Action[]> {
  const state = await readState(home);
  const previous = state.groups[group] ?? {};
  files = files.filter((file) => !skip.includes(file.target) && !hold.includes(file.target));
  const targets = new Set<string>();
  const actions: Action[] = [];
  for (const file of files) {
    inside(home, file.target);
    if (file.target === ".local/state/fleet" || file.target.startsWith(".local/state/fleet/") || statePath.startsWith(`${file.target}/`)) throw new Error("A managed target cannot replace Fleet state");
    if (files.some((other) => other !== file && other.target.startsWith(`${file.target}/`))) throw new Error(`Overlapping targets: ${file.target}`);
  }
  for (const file of files) {
    if (targets.has(file.target)) throw new Error(`Duplicate target: ${file.target}`);
    targets.add(file.target);
    const path = inside(home, file.target);
    await checkParents(home, file.target);
    if ("source" in file && !(await stat(file.source))) throw new Error(`Missing source: ${file.source}`);
    for (const [name, entries] of Object.entries(state.groups)) {
      if (name !== group && file.target in entries) throw new Error(`Target belongs to ${name}: ${file.target}`);
    }
    if (await matches(path, record(file))) actions.push({ target: file.target, operation: "keep" });
    else if (!(await stat(path))) actions.push({ target: file.target, operation: "create" });
    else if ((previous[file.target] && await matches(path, previous[file.target])) || adopt.includes(file.target)) {
      actions.push({ target: file.target, operation: "replace" });
    } else actions.push({ target: file.target, operation: "conflict", reason: previous[file.target] ? "Managed file changed locally" : file.conflict ?? "Existing unmanaged item" });
  }
  for (const [target, entry] of Object.entries(previous)) {
    if (targets.has(target) || skip.includes(target)) continue;
    if (hold.includes(target)) {
      actions.push({ target, operation: "keep" });
      continue;
    }
    await checkParents(home, target);
    if (!(await stat(inside(home, target)))) continue;
    actions.push(await matches(inside(home, target), entry)
      ? { target, operation: "remove" }
      : { target, operation: "conflict", reason: "Removed item changed locally; preserve it" });
  }
  for (const target of adopt) if (!targets.has(target) && !hold.includes(target)) throw new Error(`Adoption target is not in this plan: ${target}`);
  return actions;
}

export async function install(home: string, files: DesiredFile[], group = "core", adopt: string[] = [], skip: string[] = [], hold: string[] = []) {
  home = resolve(home);
  await mkdir(home, { recursive: true });
  await checkParents(home, statePath);
  const stateDirectory = dirname(inside(home, statePath));
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const lock = resolve(stateDirectory, "lock");
  try { await mkdir(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Another Fleet operation holds ${lock}. Remove it only if that operation has stopped.`);
    throw error;
  }
  try {
    const actions = await plan(home, files, group, adopt, skip, hold);
    const conflicts = actions.filter((action) => action.operation === "conflict");
    if (conflicts.length) throw new Error(`Installation stopped. Resolve, adopt, or skip: ${conflicts.map((a) => a.target).join(", ")}`);
    const state = await readState(home);
    const run = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    const backupRoot = `.local/state/fleet/backups/${run}`;
    const completed: Array<{ path: string; backup?: string; created: boolean }> = [];
    const nextEntries: Record<string, RecordEntry> = {};
    try {
      for (const action of actions) {
        const file = hold.includes(action.target) ? undefined : files.find((item) => item.target === action.target);
        const held = state.groups[group]?.[action.target];
        if (file) nextEntries[file.target] = record(file);
        else if (held && action.operation === "keep") nextEntries[action.target] = held;
        if (action.operation === "keep") continue;
        const path = inside(home, action.target);
        await checkParents(home, action.target);
        let backup: string | undefined;
        if (await stat(path)) {
          backup = inside(home, `${backupRoot}/${action.target}`);
          await checkParents(home, `${backupRoot}/${action.target}`);
          await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
          await rename(path, backup);
        }
        const journal = { path, backup, created: false };
        completed.push(journal);
        if (file) {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          if ("source" in file) await symlink(resolve(file.source), path);
          else await writeFile(path, file.content, { flag: "wx", mode: 0o600 });
          journal.created = true;
        }
      }
      state.groups[group] = nextEntries;
      const temporary = resolve(stateDirectory, `${randomUUID()}.json`);
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, inside(home, statePath));
    } catch (error) {
      for (const entry of completed.reverse()) {
        if (entry.created) await rm(entry.path, { force: true });
        if (entry.backup) await rename(entry.backup, entry.path);
      }
      throw error;
    }
    return { actions, backupRoot: completed.some((entry) => entry.backup) ? inside(home, backupRoot) : undefined };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
