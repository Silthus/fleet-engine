import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { stringSetting } from "../../base/lib/settings.ts";

type Env = Record<string, string | undefined>;

export type Library = { path: string; repo: string; url: string; owner: string };

export const stateDir = (home: string) => join(home, ".local/state/fleet/context-library");
export const pointerFile = (home: string) => join(stateDir(home), "library.json");
export const cacheFile = (home: string) => join(stateDir(home), "catalog-cache.json");

const expand = (path: string, home: string) => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

export function cloneUrl(repo: string) {
  return repo.includes("://") || repo.includes("@") ? repo : `https://github.com/${repo}.git`;
}

export function githubSlug(repo: string) {
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return repo.replace(/\.git$/, "");
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repo.trim())?.[1];
}

export function librarySettings(env: Env, home: string): Library {
  const repo = stringSetting("context-library.repo", env).trim();
  if (!repo) throw new Error("context-library.repo is empty. Set it with fleet set context-library.repo=<owner>/<repo>.");
  const path = expand(stringSetting("context-library.path", env).trim(), home);
  if (!isAbsolute(path)) throw new Error(`context-library.path is ${JSON.stringify(path)}. Give a folder under ~/ or an absolute path.`);
  const slug = githubSlug(repo);
  const url = stringSetting("context-library.url", env).trim() || (slug ? `https://github.com/${slug}/blob/main/` : "");
  return { repo, path, url, owner: stringSetting("context-library.owner", env).trim() };
}

export function docUrl(library: Pick<Library, "url" | "path">, doc: string) {
  const encoded = doc.split("/").map(encodeURIComponent).join("/");
  return library.url ? `${library.url.replace(/\/?$/, "/")}${encoded}` : join(library.path, doc);
}

export function writePointer(home: string, library: Library) {
  mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(library)}\n`;
  try {
    if (readFileSync(pointerFile(home), "utf8") === text) return;
  } catch {}
  const partial = `${pointerFile(home)}.${process.pid}.partial`;
  writeFileSync(partial, text, { mode: 0o600 });
  renameSync(partial, pointerFile(home));
}

export function readPointer(home: string): Library | undefined {
  try {
    const value = JSON.parse(readFileSync(pointerFile(home), "utf8")) as Partial<Library>;
    return typeof value.path === "string" && isAbsolute(value.path) ? { path: value.path, repo: value.repo ?? "", url: value.url ?? "", owner: value.owner ?? "" } : undefined;
  } catch {
    return undefined;
  }
}
