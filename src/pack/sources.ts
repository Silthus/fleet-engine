import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadPacks } from "./manifest.ts";
import type { FetchedSource, SourceRef } from "./types.ts";

export async function fetchSources(refs: SourceRef[], cacheRoot: string): Promise<FetchedSource[]> {
  return Promise.all(refs.map((ref) => fetchSource(ref, cacheRoot)));
}

export async function fetchSource(ref: SourceRef, cacheRoot: string): Promise<FetchedSource> {
  const dir = join(cacheRoot, ref.name);
  const fetchError = await checkout(dir, repoUrl(ref.repo), ref.ref);
  if (!fetchError) return { ref, dir, packs: await loadPacks(dir) };
  const reason = `could not fetch ${ref.ref} from ${ref.repo}: ${fetchError}`;
  if (!existsSync(join(dir, ".git")) || !(await git(dir, "rev-parse", "--verify", "HEAD")).ok) return { ref, error: reason };
  return { ref, dir, packs: await loadPacks(dir), stale: reason };
}

export function repoUrl(repo: string) {
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}.git` : repo;
}

async function checkout(dir: string, url: string, ref: string): Promise<string | undefined> {
  await mkdir(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) await git(dir, "init", "-q");
  const fetched = await git(dir, "fetch", "-q", "--depth", "1", "--no-tags", url, ref);
  if (!fetched.ok) return fetched.stderr;
  const moved = await git(dir, "checkout", "-q", "--force", "--detach", "FETCH_HEAD");
  return moved.ok ? undefined : moved.stderr;
}

async function git(dir: string, ...args: string[]) {
  const process = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" } });
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  return { ok: code === 0, stderr: stderr.trim().split("\n").at(-1) ?? "" };
}
