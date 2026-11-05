import { realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { freeBytes } from "../../base/lib/disk.ts";
import { modelTable } from "../../base/lib/models.ts";
import { numberSetting } from "../../base/lib/settings.ts";
import { withT3Session, type T3SessionOptions } from "../../base/lib/t3/index.ts";
import type { Env, Result } from "./coder.ts";
import { spawnText } from "./hub-job.ts";

const gigabyte = 1024 ** 3;
const minute = 60_000;
const t3CleanupMinutes = 20;
const judgeMinutes = 30;
const fallbackJudge = { model: "claude-sonnet-5-5", effort: "high" };

export type CleanupReport = { counts: { removed: number; kept: number; failed: number }; bytesFreed: number };
export type Judge = { model: string; effort: string };
export type Candidate = { path: string; reason: string };
export type Verdict = { remove: string } | { refuse: string };

export type DiskSweepOptions = {
  dryRun: boolean; floorGigabytes: number;
  free: () => number;
  cleanup: () => Promise<CleanupReport>;
  judge: (prompt: string) => Promise<Result>;
  check: (path: string) => Verdict;
  remove: (path: string) => void;
  log: (line: string) => void;
  print: (line: string) => void;
};

const readOnlyTools = [
  "Read", "Glob", "Grep", "Bash(du *)", "Bash(ls *)", "Bash(df *)", "Bash(find *)", "Bash(git status*)", "Bash(git log*)", "Bash(git -C * status*)", "Bash(git -C * log*)",
];
const losesWork = [
  "Bash(git *--force*)", "Bash(git * -f*)", "Bash(git *branch -D*)", "Bash(git *branch --delete*)", "Bash(git *stash drop*)",
  "Bash(git *stash clear*)", "Bash(git *reset --hard*)", "Bash(git *restore*)", "Bash(git *clean *)", "Bash(git *push*)",
  "Bash(*find * -delete*)", "Bash(kill *)", "Bash(pkill *)", "Bash(systemctl *)", "Bash(docker volume*)", "Bash(docker system prune*)",
  "Bash(docker rm*)", "Bash(docker container*)", "Bash(docker stop*)", "Bash(docker compose*)", "Bash(t3 doctor*)",
];
const removes = [
  "Write", "Edit", "Bash(rm *)", "Bash(*mv *)", "Bash(git *worktree remove*)", "Bash(git *worktree prune*)", "Bash(pnpm store prune*)",
  "Bash(uv cache*)", "Bash(docker * prune*)", "Bash(go clean*)",
];
const findWrites = ["Bash(*find * -exec*)", "Bash(*find * -ok*)", "Bash(*find * -fprint*)", "Bash(*find * -fls*)"];
const neverTouched = [".config", ".ssh", ".agents", ".claude", ".codex", ".t3/userdata", ".local/state", ".local/share/fleet"];

export async function diskSweep(options: DiskSweepOptions): Promise<number> {
  const shownFree = () => `${(options.free() / gigabyte).toFixed(1)}G free`;
  options.log(`Sweep${options.dryRun ? " (dry run)" : ""}: ${shownFree()}.`);
  if (options.dryRun) options.log("T3 storage cleanup skipped: T3 has no dry run.");
  else {
    try {
      const { counts: { removed, kept, failed }, bytesFreed } = await options.cleanup();
      options.log(`T3 storage cleanup: removed ${removed}, kept ${kept}, failed ${failed}, freed ${(bytesFreed / gigabyte).toFixed(1)}G. ${shownFree()}.`);
    } catch (error) {
      options.log(`T3 storage cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const judged = await options.judge(sweepPrompt(options.free(), options.floorGigabytes));
  const candidates = judged.code === 0 ? parseCandidates(judged.stdout) : undefined;
  if (!candidates) {
    options.log(`Judgment pass failed${judged.code === 0 ? ": the judge returned no candidate list." : ":"} ${shownFree()}.`);
    options.print(judged.stdout.trim() || judged.stderr.trim() || "The judgment pass printed nothing.");
    return 1;
  }
  for (const candidate of candidates) settle(candidate, options);
  options.log(`Judgment pass done: ${shownFree()}.`);
  options.print(judged.stdout.replace(/```json[\s\S]*?```/g, "").trim() || "The judge wrote no report.");
  return 0;
}

function settle(candidate: Candidate, options: DiskSweepOptions): void {
  const verdict = options.check(candidate.path);
  if ("refuse" in verdict) return options.log(`Refused ${candidate.path}: ${verdict.refuse}.`);
  if (options.dryRun) return options.log(`Would remove ${verdict.remove}: ${candidate.reason}.`);
  try {
    options.remove(verdict.remove);
    options.log(`Removed ${verdict.remove}: ${candidate.reason}.`);
  } catch (error) {
    options.log(`Could not remove ${verdict.remove}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseCandidates(output: string): Candidate[] | undefined {
  const block = [...output.matchAll(/```json\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  try {
    const { candidates } = JSON.parse(block ?? output) as { candidates?: unknown };
    if (!Array.isArray(candidates)) return undefined;
    return candidates.filter((item): item is Candidate => typeof item?.path === "string" && typeof item?.reason === "string");
  } catch { return undefined; }
}

const isInside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
const realOrResolved = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

export function sweepGuard(home: string, env: Env): (path: string) => Verdict {
  const realHome = realOrResolved(home);
  const kept = [...neverTouched.map((dir) => join(home, dir)), env.FLEET_MEMORY_DIR ?? join(home, ".agents/memory")].map(realOrResolved);
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(key)));
  const run = (argv: string[]) => {
    const child = Bun.spawnSync(argv, { env: gitEnv as Record<string, string>, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode, out: child.stdout.toString().trim(), err: child.stderr.toString() };
  };
  return (candidate) => {
    const path = candidate === "~" ? home : candidate.startsWith("~/") ? join(home, candidate.slice(2)) : candidate;
    if (!isAbsolute(path)) return { refuse: "it is not an absolute path" };
    let real: string;
    try { real = realpathSync(path); } catch { return { refuse: "it does not exist" }; }
    if (!isInside(real, realHome)) return { refuse: "it is outside $HOME" };
    if (real === realHome || dirname(real) === realHome) return { refuse: "it is $HOME or a folder directly under it" };
    const keeper = kept.find((dir) => isInside(real, dir));
    if (keeper) return { refuse: `it is inside ${keeper}, which the sweep never touches` };
    const refusal = gitRefusal(real, run);
    return refusal ? { refuse: refusal } : { remove: real };
  };
}

type Run = (argv: string[]) => { code: number; out: string; err: string };

function gitRefusal(path: string, run: Run): string | undefined {
  const isDir = statSync(path).isDirectory();
  const git = (...args: string[]) => run(["git", "-C", isDir ? path : dirname(path), ...args]);
  const inGitDir = git("rev-parse", "--is-inside-git-dir");
  if (inGitDir.code === 0) {
    if (inGitDir.out === "true") return "it is inside a Git directory";
    if (realOrResolved(git("rev-parse", "--show-toplevel").out) === path) return "it is a Git work tree root";
    const status = git("status", "--porcelain");
    if (status.code !== 0 || status.out) return "its Git work tree has uncommitted changes or untracked files";
    const unpushed = git("rev-list", "--count", "HEAD", "--not", "--remotes");
    if (unpushed.code !== 0 || unpushed.out !== "0") return "its Git work tree has commits that no remote holds";
  } else if (!inGitDir.err.includes("not a git repository")) return "Git cannot read the folder around it";
  if (!isDir) return undefined;
  const nested = run(["find", path, "-name", ".git", "-print", "-quit"]);
  if (nested.code !== 0) return "it cannot be searched for Git repositories";
  return nested.out ? "it holds a Git repository" : undefined;
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true });
}

export function runT3Cleanup(session: T3SessionOptions = {}): Promise<CleanupReport> {
  return withT3Session(
    (client) => client.call<CleanupReport>("server.runStorageCleanup", {}, t3CleanupMinutes * minute),
    { ttl: `${t3CleanupMinutes + 5}m`, scopes: ["orchestration:read", "access:read", "settings:write"], ...session },
  );
}

export function judgeModel(env: Env): Judge {
  try {
    const row = modelTable(env).find((candidate) => candidate.role === "survey" && candidate.provider === "claude");
    return row ? { model: row.model, effort: row.effort } : fallbackJudge;
  } catch { return fallbackJudge; }
}

export function judgeArgv(judge: Judge): string[] {
  return [
    "claude", "-p", "--model", judge.model, "--effort", judge.effort, "--no-session-persistence", "--restricted", "--strict-mcp-config",
    "--permission-mode", "dontAsk", "--tools", "Bash,Read,Glob,Grep", "--allowedTools", ...readOnlyTools, "--disallowedTools", ...losesWork, ...removes, ...findWrites,
  ];
}

function sweepPrompt(free: number, floorGigabytes: number): string {
  return `This box has ${(free / gigabyte).toFixed(1)}G free in $HOME. Under ${floorGigabytes}G, lanes stop, and a full disk crashes T3 and every agent on the box.
The Fleet prune pass already removed the worktrees that rules alone can prove safe, and T3 ran its own storage cleanup. You add judgment: find the space whose loss costs nothing, and propose it.
You cannot delete anything. This command removes what you propose, after its own checks, and refuses the rest.

Look, read-only, with only these: \`df -h ~\`, \`du -xsh <path>\`, \`ls\`, \`find\` without \`-delete\` or \`-exec\`, \`git -C <path> status\`, \`git -C <path> log\`, and the Read, Glob and Grep tools. Use no pipes and no redirection.
- \`du -xsh\` the folders under ~ to find the largest consumers.
- Grep "Disk pressure|Largest|evict" in ~/.local/state/fleet/jobs/worktree-prune.log for the recent prune passes.

Propose:
- Caches and downloads that tools fill again on their own, such as folders under ~/.cache, a package manager's store, or a build cache, while no process of that tool runs: \`ls -l /proc/*/cwd\` shows where processes run.
- Dependencies and build output inside a Git work tree whose \`git status --porcelain\` lists nothing and whose commits are all pushed, while no process has its working directory inside it.

The command refuses these, so do not propose them: a path outside ~, ~ itself or a folder directly under it, a Git work tree root, anything that holds a Git repository or is inside a Git directory, anything inside a work tree with uncommitted, untracked or unpushed work, and anything inside ~/.config, ~/.ssh, ~/.agents, ~/.claude, ~/.codex, ~/.t3/userdata, ~/.local/state, ~/.local/share/fleet, or the memory checkout. Never propose a folder of personal notes or a file that holds a credential. When you are not sure, leave it out.

Write a report of at most 12 lines: the largest consumers, what you propose and its size, and what is left that only your user can decide. Then end your reply with one JSON block, with absolute paths, and nothing after it:
\`\`\`json
{"candidates": [{"path": "/absolute/path", "reason": "why its loss costs nothing"}]}
\`\`\``;
}

export async function diskSweepCommand(args: string[], context: { home: string; env: Env }): Promise<number> {
  const dryRun = args[0] === "--dry-run";
  if (args.length > Number(dryRun)) throw new Error("Usage: fleet disk-sweep [--dry-run]");
  const { home, env } = context;
  const judge = judgeModel(env);
  return diskSweep({
    dryRun, floorGigabytes: numberSetting("base.diskFloorGigabytes", env),
    free: () => freeBytes(home),
    cleanup: () => runT3Cleanup({ home }),
    judge: (prompt) => spawnText(judgeArgv(judge), env, { stdin: prompt, timeoutMs: judgeMinutes * minute, cwd: home }),
    check: sweepGuard(home, env), remove: removePath,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    print: (line) => console.log(line),
  });
}
