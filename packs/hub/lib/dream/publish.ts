import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { secretKinds } from "../../../base/hooks/secret-guard.ts";
import type { Result } from "../coder.ts";

type Git = (...args: string[]) => Promise<Result>;
type Must = (...args: string[]) => Promise<string>;
export type Published = { code: number; message: string };

const attempts = 3;
const linkModes = new Set(["120000", "160000"]);
const operations = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];

function rawEntries(output: string) {
  const fields = output.split("\0");
  const entries: Array<{ mode: string; path: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) entries.push({ mode: fields[index]!.split(" ")[1] ?? "", path: fields[index + 1]! });
  return entries;
}

async function outgoingProblem(must: Must, subtree: string): Promise<string | undefined> {
  const final = rawEntries(await must("diff", "--raw", "-z", "--no-renames", "--no-abbrev", "origin/main", "HEAD"));
  const outside = subtree ? final.map(({ path }) => path).filter((path) => !path.startsWith(`${subtree}/`) && !path.startsWith("dreams/")) : [];
  if (outside.length) return `the commits change files outside ${subtree}/ and dreams/: ${outside.join(", ")}.`;
  const links = final.filter(({ mode }) => linkModes.has(mode)).map(({ path }) => path);
  if (links.length) return `the commits add a symlink or a submodule: ${links.join(", ")}. Memory holds plain files only.`;
  const names = await must("log", "--format=", "--name-only", "-z", "-m", "--no-renames", "origin/main..HEAD");
  const messages = await must("log", "--format=%B", "origin/main..HEAD");
  const objects = (await must("rev-list", "--objects", "--no-object-names", "HEAD", "--not", "origin/main")).split("\n").filter(Boolean);
  const kinds = new Set(secretKinds(`${messages}\n${names.replaceAll("\0", "\n")}`));
  for (const object of objects) {
    if ((await must("cat-file", "-t", object)).trim() !== "blob") continue;
    const text = await must("cat-file", "blob", object);
    if (text.includes("\0")) return "the commits add a binary file. Memory holds text only.";
    if (/^(<<<<<<<|>>>>>>>) /m.test(text)) return "the commits add a conflict marker.";
    for (const kind of secretKinds(text)) kinds.add(kind);
  }
  return kinds.size ? `the commits hold a secret (${[...kinds].join(", ")}), in this or an earlier commit. Remove it and rewrite the commits.` : undefined;
}

const sameRepo = async (g: Git, memory: string, git: (args: string[]) => Promise<Result>) => {
  const common = async (answer: Promise<Result>) => {
    const path = (await answer).stdout.trim();
    return path && existsSync(path) ? realpathSync(path) : undefined;
  };
  const worktree = await common(g("rev-parse", "--path-format=absolute", "--git-common-dir"));
  return worktree !== undefined && worktree === await common(git(["-C", memory, "rev-parse", "--path-format=absolute", "--git-common-dir"]));
};

export async function publish(worktree: string, subtree: string, memory: string, git: (args: string[]) => Promise<Result>): Promise<Published> {
  const g: Git = (...args) => git(["-c", "commit.gpgsign=false", "-C", worktree, ...args]);
  const must: Must = async (...args) => {
    const answer = await g(...args);
    if (answer.code !== 0) throw new Error(`git ${args[0]} failed`);
    return answer.stdout;
  };
  if (!(await sameRepo(g, memory, git))) return { code: 1, message: `${worktree} is not a worktree of the memory checkout ${memory}.` };
  const markers = (await g("rev-parse", ...operations.flatMap((name) => ["--git-path", name]))).stdout.split("\n").filter(Boolean);
  if (markers.length !== operations.length || markers.some((path) => existsSync(resolve(worktree, path)))) return { code: 1, message: "the worktree is in the middle of a rebase, merge, cherry-pick or revert. Finish or abort it, then publish again." };
  if ((await g("status", "--porcelain", "--untracked-files=all")).stdout.trim()) return { code: 1, message: "the worktree has uncommitted changes. Commit each change first." };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if ((await g("fetch", "--quiet", "origin", "main")).code !== 0) return { code: 1, message: "cannot fetch origin main." };
    const merges = Number((await g("rev-list", "--merges", "--count", "origin/main..HEAD")).stdout.trim()) > 0;
    const current = (await g("merge-base", "--is-ancestor", "origin/main", "HEAD")).code === 0;
    const settled = current ? { code: 0 } : merges ? await g("merge", "--quiet", "--no-edit", "origin/main") : await g("rebase", "--quiet", "origin/main");
    if (settled.code !== 0) {
      const conflicts = (await g("diff", "--name-only", "--diff-filter=U")).stdout.trim().split("\n").filter(Boolean).join(", ");
      await g(merges ? "merge" : "rebase", "--abort");
      return { code: 1, message: `rebasing onto main conflicts in ${conflicts || "the worktree"}. Merge origin/main, keep both sides, and publish again.` };
    }
    if (Number((await g("rev-list", "--count", "origin/main..HEAD")).stdout.trim()) === 0) return { code: 0, message: "nothing to publish." };
    let refused: string | undefined;
    try {
      refused = await outgoingProblem(must, subtree);
    } catch (error) {
      refused = `cannot check the outgoing commits: ${(error as Error).message}.`;
    }
    if (refused) return { code: 1, message: refused };
    if ((await g("push", "--quiet", "origin", "HEAD:main")).code === 0) return { code: 0, message: `pushed ${(await g("rev-parse", "--short", "HEAD")).stdout.trim()} to main.` };
  }
  return { code: 1, message: `the push failed ${attempts} times; another machine kept pushing first. Publish again.` };
}
