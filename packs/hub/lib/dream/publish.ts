import { secretKinds } from "../../../base/hooks/secret-guard.ts";
import type { Result } from "../coder.ts";

type Git = (...args: string[]) => Promise<Result>;
export type Published = { code: number; message: string };

const attempts = 3;

async function outgoingProblem(g: Git, subtree: string): Promise<string | undefined> {
  const paths = (await g("log", "--format=", "--name-only", "-z", "--no-renames", "--diff-merges=dense-combined", "origin/main..HEAD")).stdout.split("\0").map((path) => path.trim()).filter(Boolean);
  const outside = subtree ? [...new Set(paths.filter((path) => !path.startsWith(`${subtree}/`) && !path.startsWith("dreams/")))] : [];
  if (outside.length) return `the commits change files outside ${subtree}/ and dreams/: ${outside.join(", ")}.`;
  const messages = (await g("log", "--format=%B", "origin/main..HEAD")).stdout;
  const objects = (await g("rev-list", "--objects", "--no-object-names", "HEAD", "--not", "origin/main")).stdout.split("\n").filter(Boolean);
  const kinds = new Set(secretKinds(messages));
  for (const object of objects) {
    if ((await g("cat-file", "-t", object)).stdout.trim() !== "blob") continue;
    const text = (await g("cat-file", "blob", object)).stdout;
    if (text.includes("\0")) return "the commits add a binary file. Memory holds text only.";
    if (/^(<<<<<<<|>>>>>>>) /m.test(text)) return "the commits add a conflict marker.";
    for (const kind of secretKinds(text)) kinds.add(kind);
  }
  return kinds.size ? `the commits hold a secret (${[...kinds].join(", ")}), in this or an earlier commit. Remove it and rewrite the commits.` : undefined;
}

export async function publish(worktree: string, subtree: string, git: (args: string[]) => Promise<Result>): Promise<Published> {
  const g: Git = (...args) => git(["-c", "commit.gpgsign=false", "-C", worktree, ...args]);
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
    const refused = await outgoingProblem(g, subtree);
    if (refused) return { code: 1, message: refused };
    if ((await g("push", "--quiet", "origin", "HEAD:main")).code === 0) return { code: 0, message: `pushed ${(await g("rev-parse", "--short", "HEAD")).stdout.trim()} to main.` };
  }
  return { code: 1, message: `the push failed ${attempts} times; another machine kept pushing first. Publish again.` };
}
