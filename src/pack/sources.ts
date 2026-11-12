import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { loadPacks } from "./manifest.ts";
import { tryLock, waitLock } from "../lock.ts";
import type { AvailableSource, FetchedSource, LoadedPack, SourceRef } from "./types.ts";

const sourceName = /^[a-z0-9][a-z0-9-]*$/;
const fetchTimeoutMs = 120_000;
const cacheWaitMs = 10 * 60_000;

export type Clock = { now(): number; sleep(ms: number): Promise<void> };

const realClock: Clock = { now: Date.now, sleep: (ms) => Bun.sleep(ms) };

/** What the cache last loaded successfully: the source's repository, ref, and commit. */
type Good = { repo: string; ref: string; commit: string };

export async function fetchSources(refs: SourceRef[], cacheRoot: string): Promise<FetchedSource[]> {
  return Promise.all(refs.map((ref) => fetchSource(ref, cacheRoot)));
}

/**
 * Fetches a source at its ref into <cacheRoot>/<name>. A fetch that fails, or
 * that brings packs which do not load, falls back to the last good checkout
 * of the same repository and reports it as stale. A checkout with edits to
 * its tracked files keeps them, and reports itself as stale instead.
 */
export async function fetchSource(ref: SourceRef, cacheRoot: string, loadLimitMs = fetchTimeoutMs, clock: Clock = realClock): Promise<FetchedSource> {
  const dir = cacheDir(ref, cacheRoot);
  if (typeof dir !== "string") return { ref, error: dir.error };
  const lock = await waitLock(cacheLock(cacheRoot, ref.name), clock.now, clock.sleep, cacheWaitMs);
  if (!lock) return { ref, error: `another Fleet run kept working in ${dir} for over ${cacheWaitMs / 60_000} minutes` };
  try {
    return await fetchLocked(ref, dir, loadLimitMs);
  } finally {
    lock.release();
  }
}

async function fetchLocked(ref: SourceRef, dir: string, loadLimitMs: number): Promise<FetchedSource> {
  const repo = repoUrl(ref.repo);
  const edits = await localEdits(dir);
  if (edits.length) return keepEdits(ref, dir, edits, loadLimitMs);
  const good = await lastGood(dir);
  const fetchError = await checkout(dir, repo, ref.ref);
  if (!fetchError) {
    const loaded = await load(dir, loadLimitMs);
    if (!("error" in loaded)) {
      await saveGood(dir, { repo, ref: ref.ref, commit: (await git(dir, "rev-parse", "HEAD")).stdout });
      return { ref, dir, packs: loaded.packs };
    }
    return fallBack(ref, dir, repo, good, `${ref.ref} from ${ref.repo} does not load: ${loaded.error}`, loadLimitMs);
  }
  return fallBack(ref, dir, repo, good, `could not fetch ${ref.ref} from ${ref.repo}: ${fetchError}`, loadLimitMs);
}

function cacheDir(ref: SourceRef, cacheRoot: string): string | { error: string } {
  const dir = resolve(cacheRoot, ref.name);
  if (!sourceName.test(ref.name) || relative(resolve(cacheRoot), dir) !== ref.name) {
    return { error: `source name ${JSON.stringify(ref.name)} must be lowercase words joined by dashes` };
  }
  return dir;
}

const cacheLock = (cacheRoot: string, name: string) => join(cacheRoot, `${name}.lock`);

/** The tracked files that differ from the checked-out commit, such as a skill edited through its link. */
async function localEdits(dir: string) {
  if (!existsSync(join(dir, ".git"))) return [];
  const changed = await git(dir, "diff", "--name-only", "HEAD", "--");
  return changed.ok && changed.stdout ? changed.stdout.split("\n") : [];
}

function editsReason(ref: SourceRef, dir: string, edits: string[]) {
  return `kept your edits to ${edits.join(", ")} in ${dir}. Commit or undo them there, and Fleet updates ${ref.name} again`;
}

async function keepEdits(ref: SourceRef, dir: string, edits: string[], loadLimitMs: number): Promise<FetchedSource> {
  const reason = editsReason(ref, dir, edits);
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) return { ref, error: `${reason}; ${loaded.error}` };
  return { ref, dir, packs: loaded.packs, stale: reason };
}

export function repoUrl(repo: string) {
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}.git` : repo;
}

async function fallBack(ref: SourceRef, dir: string, repo: string, good: Good | undefined, reason: string, loadLimitMs: number): Promise<FetchedSource> {
  if (!good || good.repo !== repo) return { ref, error: reason };
  if (!(await git(dir, "checkout", "-q", "--detach", good.commit)).ok) return { ref, error: reason };
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) return { ref, error: reason };
  return { ref, dir, packs: loaded.packs, stale: good.ref === ref.ref ? reason : `${reason}; using ${good.ref} instead` };
}

const loadedModules = createRequire(import.meta.url).cache;

async function load(dir: string, limitMs: number): Promise<{ packs: LoadedPack[] } | { error: string }> {
  if (await hasPackTs(dir)) {
    const error = await loadsElsewhere(dir, limitMs);
    if (error) return { error };
    const folders = [resolve(dir), realpathSync(dir)].map((folder) => folder + sep);
    for (const loaded of Object.keys(loadedModules)) if (folders.some((folder) => loaded.startsWith(folder))) delete loadedModules[loaded];
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
  const moved = await git(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
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

export function sourceCache(home: string) {
  return join(home, ".local", "share", "fleet", "sources");
}

export async function followsBranch(ref: SourceRef, cacheRoot: string) {
  const fetched = await readFile(join(cacheRoot, ref.name, ".git", "FETCH_HEAD"), "utf8").catch(() => "");
  const branch = ref.ref.replace(/^refs\/heads\//, "");
  return fetched.split("\n")[0]?.includes(`\tbranch '${branch}' of `) ?? false;
}

export async function loadedCommit(ref: SourceRef, cacheRoot: string) {
  return (await lastGood(join(cacheRoot, ref.name)))?.commit;
}

export type Advance =
  | { state: "same"; commit: string }
  | { state: "moved"; commit: string; source: AvailableSource }
  | { state: "busy" }
  | { state: "edited"; say: string }
  | { state: "refused"; commit: string; say: string }
  | { state: "failed"; say: string };

/**
 * Moves a branch source forward from the commit it last loaded, for fleet refresh.
 * It asks the remote first and fetches only when the branch moved. It leaves the
 * source as it is while another run works in its cache, while it has local edits,
 * and when the new commit does not build on the old one.
 */
export async function advanceSource(ref: SourceRef, cacheRoot: string, from: string, refused: string | undefined, now: number, loadLimitMs = fetchTimeoutMs): Promise<Advance> {
  const dir = cacheDir(ref, cacheRoot);
  if (typeof dir !== "string") return { state: "failed", say: dir.error };
  const lock = tryLock(cacheLock(cacheRoot, ref.name), now);
  if (!lock) return { state: "busy" };
  try {
    return await advanceLocked(ref, dir, from, refused, loadLimitMs);
  } finally {
    lock.release();
  }
}

async function advanceLocked(ref: SourceRef, dir: string, from: string, refused: string | undefined, loadLimitMs: number): Promise<Advance> {
  const repo = repoUrl(ref.repo);
  const branch = ref.ref.replace(/^refs\/heads\//, "");
  const head = `refs/heads/${branch}`;
  const listed = await git(dir, "ls-remote", repo, head);
  if (!listed.ok) return { state: "failed", say: `could not reach ${ref.repo}: ${listed.stderr}` };
  const commit = listed.stdout.split("\n").map((line) => line.split("\t")).find(([, name]) => name === head)?.[0];
  if (!commit) return { state: "failed", say: `${ref.repo} has no branch ${branch}` };
  if (commit === from) return { state: "same", commit };
  const rewritten = (tip: string) => ({ state: "refused" as const, commit: tip, say: `${branch} of ${ref.repo} moved to ${tip.slice(0, 12)}, which does not build on ${from.slice(0, 12)}, the commit Fleet loaded last. Fleet refresh runs no pack code from a rewritten branch. Run fleet update to take it.` });
  if (commit === refused) return rewritten(commit);
  const edits = await localEdits(dir);
  if (edits.length) return { state: "edited", say: `${ref.name} moved, but Fleet ${editsReason(ref, dir, edits)}.` };
  const fetched = await git(dir, "fetch", "-q", "--no-tags", repo, head);
  if (!fetched.ok) return { state: "failed", say: `could not fetch ${branch} from ${ref.repo}: ${fetched.stderr}` };
  const tip = (await git(dir, "rev-parse", "FETCH_HEAD")).stdout;
  if (!(await git(dir, "merge-base", "--is-ancestor", from, tip)).ok) return rewritten(tip);
  const moved = await git(dir, "checkout", "-q", "--detach", tip);
  if (!moved.ok) return { state: "failed", say: `could not check out ${tip.slice(0, 12)} of ${ref.name}: ${moved.stderr}` };
  const loaded = await load(dir, loadLimitMs);
  if ("error" in loaded) {
    await git(dir, "checkout", "-q", "--detach", from);
    return { state: "failed", say: `${branch} of ${ref.repo} at ${tip.slice(0, 12)} does not load: ${loaded.error}` };
  }
  await saveGood(dir, { repo, ref: ref.ref, commit: tip });
  return { state: "moved", commit: tip, source: { ref, dir, packs: loaded.packs } };
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

async function loadsElsewhere(dir: string, limitMs: number): Promise<string | undefined> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "load-source.ts"), dir], { env: process.env, stdout: "ignore", stderr: "pipe", timeout: limitMs, killSignal: "SIGKILL" });
  const stderr = readUntilQuiet(child.stderr);
  const code = await child.exited;
  if (code === 0) return undefined;
  if (performance.now() - started >= limitMs) return `the packs did not finish loading within ${limitMs / 1000} seconds`;
  const lastLine = (await stderr()).trim().split("\n").at(-1);
  const how = child.signalCode ? `stop on ${child.signalCode}` : `exit ${code}`;
  return [`the packs ${how} as they load`, lastLine].filter(Boolean).join(": ");
}

const drainMs = 100;

function readUntilQuiet(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += decoder.decode(chunk.value, { stream: true });
  })().catch(() => {});
  return async () => {
    const drained = await Promise.race([done.then(() => true), Bun.sleep(drainMs).then(() => false)]);
    if (!drained) await reader.cancel().catch(() => {});
    return text;
  };
}
