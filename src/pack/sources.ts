import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { loadPacks } from "./manifest.ts";
import type { FetchedSource, LoadedPack, SourceRef } from "./types.ts";

const sourceName = /^[a-z0-9][a-z0-9-]*$/;
const fetchTimeoutMs = 120_000;

/** What the cache last loaded successfully: the source's repository, ref, and commit. */
type Good = { repo: string; ref: string; commit: string };

export async function fetchSources(refs: SourceRef[], cacheRoot: string): Promise<FetchedSource[]> {
  return Promise.all(refs.map((ref) => fetchSource(ref, cacheRoot)));
}

/**
 * Fetches a source at its ref into <cacheRoot>/<name>. A fetch that fails, or
 * that brings packs which do not load, falls back to the last good checkout
 * of the same repository and reports it as stale.
 */
export async function fetchSource(ref: SourceRef, cacheRoot: string): Promise<FetchedSource> {
  const dir = resolve(cacheRoot, ref.name);
  if (!sourceName.test(ref.name) || relative(resolve(cacheRoot), dir) !== ref.name) {
    return { ref, error: `source name ${JSON.stringify(ref.name)} must be lowercase words joined by dashes` };
  }
  const repo = repoUrl(ref.repo);
  const good = await lastGood(dir);
  const fetchError = await checkout(dir, repo, ref.ref);
  if (!fetchError) {
    const loaded = await load(dir);
    if (!("error" in loaded)) {
      await saveGood(dir, { repo, ref: ref.ref, commit: (await git(dir, "rev-parse", "HEAD")).stdout });
      return { ref, dir, packs: loaded.packs };
    }
    return fallBack(ref, dir, repo, good, `${ref.ref} from ${ref.repo} does not load: ${loaded.error}`);
  }
  return fallBack(ref, dir, repo, good, `could not fetch ${ref.ref} from ${ref.repo}: ${fetchError}`);
}

export function repoUrl(repo: string) {
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}.git` : repo;
}

async function fallBack(ref: SourceRef, dir: string, repo: string, good: Good | undefined, reason: string): Promise<FetchedSource> {
  if (!good || good.repo !== repo) return { ref, error: reason };
  if (!(await git(dir, "checkout", "-q", "--force", "--detach", good.commit)).ok) return { ref, error: reason };
  const loaded = await load(dir);
  if ("error" in loaded) return { ref, error: reason };
  return { ref, dir, packs: loaded.packs, stale: good.ref === ref.ref ? reason : `${reason}; using ${good.ref} instead` };
}

const loadedModules = createRequire(import.meta.url).cache;

async function load(dir: string): Promise<{ packs: LoadedPack[] } | { error: string }> {
  if (await hasPackTs(dir)) {
    const error = await loadsElsewhere(dir);
    if (error) return { error };
    for (const loaded of Object.keys(loadedModules)) if (loaded.startsWith(resolve(dir) + sep)) delete loadedModules[loaded];
  }
  try {
    return { packs: await loadPacks(dir) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function goodPath(dir: string) {
  return join(dir, ".git", "fleet-source.json");
}

async function lastGood(dir: string): Promise<Good | undefined> {
  try {
    return JSON.parse(await readFile(goodPath(dir), "utf8")) as Good;
  } catch {
    return undefined;
  }
}

async function saveGood(dir: string, good: Good) {
  await writeFile(goodPath(dir), JSON.stringify(good) + "\n");
}

async function checkout(dir: string, url: string, ref: string): Promise<string | undefined> {
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) await git(dir, "init", "-q");
  const fetched = await git(dir, "fetch", "-q", "--depth", "1", "--no-tags", url, ref);
  if (!fetched.ok) return fetched.stderr;
  const moved = await git(dir, "checkout", "-q", "--force", "--detach", "FETCH_HEAD");
  return moved.ok ? undefined : moved.stderr;
}

/** Runs git without any prompt: no terminal, no askpass program, SSH in batch mode, and a time limit. */
async function git(dir: string, ...args: string[]) {
  const env = { ...Bun.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  const process = Bun.spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: fetchTimeoutMs });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  const message = process.signalCode ? `git timed out after ${fetchTimeoutMs / 1000} seconds` : (stderr.trim().split("\n").at(-1) ?? "");
  return { ok: code === 0, stdout: stdout.trim(), stderr: message };
}

export async function cachedSource(ref: SourceRef, cacheRoot: string): Promise<FetchedSource> {
  const dir = join(cacheRoot, ref.name);
  if (!existsSync(join(dir, ".git"))) return { ref, error: "never fetched; run fleet apply" };
  return { ref, dir, packs: await loadPacks(dir) };
}

async function hasPackTs(dir: string) {
  const packs = await readdir(join(dir, "packs")).catch(() => [] as string[]);
  return packs.some((name) => existsSync(join(dir, "packs", name, "pack.ts")));
}

async function loadsElsewhere(dir: string): Promise<string | undefined> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "load-source.ts"), dir], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 ? undefined : out.trim() || `the packs exit ${code} as they load`;
}
