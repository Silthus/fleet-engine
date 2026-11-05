import { freeBytes } from "../../base/lib/disk.ts";
import { modelTable } from "../../base/lib/models.ts";
import { numberSetting } from "../../base/lib/settings.ts";
import { withT3Session, type T3SessionOptions } from "../../base/lib/t3/index.ts";
import type { Env, Result } from "./coder.ts";
import { spawnText } from "./hub-job.ts";
import { remoteFleet } from "./machine.ts";

const gigabyte = 1024 ** 3;
const minute = 60_000;
const t3CleanupMinutes = 20;
const judgeMinutes = 30;
const fallbackJudge = { model: "claude-sonnet-5-5", effort: "high" };

export type CleanupReport = { counts: { removed: number; kept: number; failed: number }; bytesFreed: number };
export type Judge = { model: string; effort: string };

export type DiskSweepOptions = {
  dryRun: boolean; floorGigabytes: number;
  free: () => number;
  cleanup: () => Promise<CleanupReport>;
  judge: (prompt: string, denied: string[]) => Promise<Result>;
  log: (line: string) => void;
  print: (line: string) => void;
};

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

export async function diskSweep(options: DiskSweepOptions): Promise<number> {
  const shownFree = () => `${(options.free() / gigabyte).toFixed(1)}G free`;
  options.log(`Sweep${options.dryRun ? " (dry run)" : ""}: ${shownFree()}.`);
  if (!options.dryRun) {
    try {
      const { counts: { removed, kept, failed }, bytesFreed } = await options.cleanup();
      options.log(`T3 storage cleanup: removed ${removed}, kept ${kept}, failed ${failed}, freed ${(bytesFreed / gigabyte).toFixed(1)}G. ${shownFree()}.`);
    } catch (error) {
      options.log(`T3 storage cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const judged = await options.judge(sweepPrompt(options.free(), options.floorGigabytes, options.dryRun), options.dryRun ? [...losesWork, ...removes] : losesWork);
  const ok = judged.code === 0;
  options.log(`Judgment pass ${ok ? "done" : "failed"}: ${shownFree()}.`);
  options.print(judged.stdout.trim() || judged.stderr.trim() || "The judgment pass printed nothing.");
  return ok ? 0 : 1;
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

export function judgeArgv(judge: Judge, denied: string[]): string[] {
  return ["claude", "-p", "--model", judge.model, "--effort", judge.effort, "--permission-mode", "bypassPermissions", "--no-session-persistence", "--disallowedTools", ...denied];
}

function sweepPrompt(free: number, floorGigabytes: number, dryRun: boolean): string {
  const act = dryRun
    ? "This is a dry run. Delete nothing. List what you would remove, with its size and the proof that it is safe."
    : "Remove everything that is safe to remove. Nobody watches this run and nobody can answer a question, so decide yourself. When you are not sure, keep it.";
  return `This box has ${(free / gigabyte).toFixed(1)}G free in $HOME. Under ${floorGigabytes}G, lanes stop, and a full disk crashes T3 and every agent on the box.
The Fleet prune pass already removed what rules alone can prove safe, and T3 ran its own storage cleanup. You add judgment: check what they kept, and free the space whose loss costs nothing.
${act}

Look first:
- \`df -h ~\`, then \`du -xsh\` on the directories under ~ to find the largest consumers.
- \`${remoteFleet("prune --dry-run --no-fetch --min-idle-hours 1")}\` lists each worktree and why the prune pass keeps it.
- \`grep -E "Disk pressure|Largest|evict" ~/.local/state/fleet/jobs/worktree-prune.log | tail -n 30\` shows the recent passes.

Safe to remove:
- A linked Git worktree (its \`.git\` is a file) when all of these hold. Remove it with \`git -C <its main checkout> worktree remove <path>\` and nothing else. When Git refuses, keep it.
  - \`git status --porcelain\` lists nothing, or only lockfiles and generated or tool output.
  - \`git status --porcelain --ignored\` lists only dependencies, build output, caches, and env files that match the main checkout's. Removal deletes ignored files too, so keep the worktree when it holds notes, scratch data, or a changed env file.
  - Every commit is on the default branch, on its remote branch (\`git log @{u}..HEAD\` is empty), or in a merged pull request (\`gh pr view <branch> --json state\`).
  - \`git stash list\` in it shows no stash made from its branch, except \`lint-staged\` backups.
  - No process has its working directory inside it: check \`ls -l /proc/*/cwd 2>/dev/null | grep <path>\`.
  - The prune dry run does not keep it because a process runs inside it, its T3 session runs, its thread waits for an answer, the T3 state is unreadable, or it was active in the last hour.
- Caches that tools fill again on their own, while no process of that tool runs: \`pnpm store prune\`, \`uv cache clean\`, \`go clean -cache\`, \`docker builder prune -f\`, \`docker image prune -f\`, and old browser or tool downloads under \`~/.cache\`.

Never:
- Remove a full clone (its \`.git\` is a directory), a primary checkout, uncommitted work, unpushed commits, stashes, or branches.
- Touch \`~/.t3/userdata\`, \`~/.claude\`, \`~/.codex\`, \`~/.config\`, \`~/.ssh\`, \`~/.local/state\`, \`~/.agents\`, a folder of personal notes, or any file that holds a credential.
- Stop, kill, or restart a process or service. Start no agent, lane, build, or install.
- Run \`rm -rf\` on a path you have not checked, or with a variable or glob that could widen it.

End with a report of at most 12 lines: the free space before and after, each thing you removed with its size, the largest consumers left and why each one stays, and whether anything is left that only your user can decide.`;
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
    judge: (prompt, denied) => spawnText(judgeArgv(judge, denied), env, { stdin: prompt, timeoutMs: judgeMinutes * minute, cwd: home }),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    print: (line) => console.log(line),
  });
}
