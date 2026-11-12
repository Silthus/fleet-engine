import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloneUrl, githubSlug, type Library } from "./config.ts";
import { must, type Git } from "./git.ts";

const sameRepo = (a: string, b: string) => (githubSlug(a) ?? a.replace(/\/+$/, "").replace(/\.git$/, "")).toLowerCase() === (githubSlug(b) ?? b.replace(/\/+$/, "").replace(/\.git$/, "")).toLowerCase();

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
  if (!(await git(["merge", "--ff-only", "--quiet", "@{upstream}"], path)).code) return 0;
  return print(`Context library: kept the local changes in ${path}. It fast-forwards again once they are committed and pushed.`), 0;
}
