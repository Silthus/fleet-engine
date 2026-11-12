import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloneUrl, githubSlug, type Library } from "./config.ts";
import { must, type Git } from "./git.ts";
import { catalogName } from "./library.ts";

const sameRepo = (a: string, b: string) => (githubSlug(a) ?? a.replace(/\/+$/, "").replace(/\.git$/, "")).toLowerCase() === (githubSlug(b) ?? b.replace(/\/+$/, "").replace(/\.git$/, "")).toLowerCase();
const commits = (count: number) => `${count} ${count === 1 ? "commit" : "commits"}`;

async function dropLocalCatalog(path: string, git: Git) {
  if (!(await git(["status", "--porcelain", "--", catalogName], path)).stdout.trim()) return false;
  await git(["reset", "--quiet", "--", catalogName], path);
  if ((await git(["cat-file", "-e", `HEAD:${catalogName}`], path)).code) rmSync(join(path, catalogName), { force: true });
  else await must(git, ["checkout", "--", catalogName], path);
  return true;
}

export async function syncLibrary(library: Library, git: Git, print: (line: string) => void): Promise<number> {
  const { path } = library;
  const url = cloneUrl(library.repo);
  if (!existsSync(join(path, ".git"))) {
    if (existsSync(path) && readdirSync(path).length) return print(`Context library: ${path} holds files but no Git checkout. Move it aside; the next sync clones ${library.repo} there.`), 1;
    mkdirSync(dirname(path), { recursive: true });
    await must(git, ["clone", "--quiet", url, path], dirname(path));
    return print(`Context library: cloned ${library.repo} to ${path}.`), 0;
  }
  const origin = (await git(["remote", "get-url", "origin"], path)).stdout.trim();
  if (!sameRepo(origin, url)) return print(`Context library: ${path} follows ${origin || "no repo"}, but context-library.repo is ${library.repo}. Move that folder aside; the next sync clones a fresh one.`), 1;
  await must(git, ["fetch", "--quiet", "origin"], path);
  if ((await git(["rev-parse", "--verify", "--quiet", "@{upstream}"], path)).code) return print(`Context library: the branch checked out in ${path} follows no remote branch, so it stays as it is.`), 0;
  const fastForward = async () => !(await git(["merge", "--ff-only", "--quiet", "@{upstream}"], path)).code;
  if (await fastForward()) return 0;
  if ((await dropLocalCatalog(path, git)) && (await fastForward())) return 0;
  const [ahead = 0, behind = 0] = (await must(git, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], path)).trim().split(/\s+/).map(Number);
  const them = ahead === 1 ? "it" : "them";
  const why = ahead
    ? `it has ${ahead} local ${ahead === 1 ? "commit" : "commits"} that main lacks. Push ${them} or drop ${them}`
    : "it has uncommitted changes that the new commits would overwrite. Commit and push them, or drop them";
  print(`Context library: ${path} is stuck ${commits(behind)} behind main: ${why}; agents read the old notes until then.`);
  return 1;
}
