import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetchSource, followsBranch, loadedCommit } from "./pack/sources.ts";
import type { FetchedSource, SourceRef } from "./pack/types.ts";

export type RefreshOptions = {
  home: string;
  cache: string;
  sources: SourceRef[];
  print: (line: string) => void;
  apply: (fetched: FetchedSource[]) => Promise<boolean>;
};

type Applied = Record<string, string>;

const statePath = (home: string) => join(home, ".local", "state", "fleet", "refresh.json");
const lockPath = (home: string) => join(home, ".local", "state", "fleet", "refresh.lock");

export async function refresh(options: RefreshOptions): Promise<number> {
  const branches = await branchSources(options.sources, options.cache);
  if (!branches.length) return 0;
  const release = await takeLock(options.home);
  if (!release) return options.print("fleet refresh: another refresh still runs, so this one stops."), 0;
  try {
    return await refreshBranches(branches, options);
  } finally {
    await release();
  }
}

async function branchSources(sources: SourceRef[], cache: string) {
  const follows = await Promise.all(sources.map((ref) => followsBranch(ref, cache)));
  return sources.filter((_, index) => follows[index]);
}

async function refreshBranches(branches: SourceRef[], options: RefreshOptions) {
  const applied = await readApplied(options.home);
  const seeded = { ...applied };
  for (const ref of branches) {
    const commit = applied[ref.name] ?? (await loadedCommit(ref, options.cache));
    if (commit) seeded[ref.name] = commit;
  }
  if (Object.keys(seeded).some((name) => seeded[name] !== applied[name])) await saveApplied(options.home, seeded);
  const fetched = await Promise.all(branches.map((ref) => fetchSource(ref, options.cache)));
  const moved: Applied = {};
  for (const source of fetched) {
    if ("error" in source) continue;
    const commit = await loadedCommit(source.ref, options.cache);
    if (commit && commit !== seeded[source.ref.name]) moved[source.ref.name] = commit;
  }
  if (!Object.keys(moved).length) return 0;
  for (const [name, commit] of Object.entries(moved)) options.print(`${name} moved to ${commit.slice(0, 12)}.`);
  if (!(await options.apply(fetched))) return 1;
  await saveApplied(options.home, { ...seeded, ...moved });
  return 0;
}

async function readApplied(home: string): Promise<Applied> {
  try {
    return JSON.parse(await readFile(statePath(home), "utf8")) as Applied;
  } catch {
    return {};
  }
}

async function saveApplied(home: string, applied: Applied) {
  await mkdir(dirname(statePath(home)), { recursive: true });
  await writeFile(statePath(home), JSON.stringify(applied) + "\n");
}

async function takeLock(home: string): Promise<(() => Promise<void>) | undefined> {
  const path = lockPath(home);
  await mkdir(dirname(path), { recursive: true });
  const mine = `${path}.${process.pid}`;
  await writeFile(mine, String(process.pid));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(mine, path);
        return () => rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (alive(Number(await readFile(path, "utf8").catch(() => "")))) return undefined;
      await rm(path, { force: true });
    }
    return undefined;
  } finally {
    await rm(mine, { force: true });
  }
}

function alive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
