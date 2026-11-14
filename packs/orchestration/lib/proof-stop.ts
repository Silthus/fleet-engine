import { realpath } from "node:fs/promises";
import { isWaiting, matchThread, type PullRequestWatch, type ShellThread } from "../../base/lib/t3/index.ts";
import { ownedPullRequests } from "../../pull-requests/lib/pr-owners.ts";
import { gateRecordPath, readJson } from "../../pull-requests/lib/proof.ts";
import { needsHuman } from "./lanes.ts";
import { personName } from "./prose-question.ts";

export type ProofStopEvent = {
  cwd?: string; stop_hook_active?: boolean; last_assistant_message?: string;
  background_tasks?: { id?: string; type?: string; status?: string }[]; session_crons?: unknown[];
};
export type Git = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
export type ProcessTable = { pid: number; table: () => Promise<string> };
export type ProofStopOptions = {
  home: string; threadId?: string; shell: () => Promise<{ threads: ShellThread[] }>;
  deadline?: () => Promise<void>; git?: Git; processes?: ProcessTable;
};
export type ProofStopBlock = { decision: "block"; reason: string };

export const proofStopDeadlineMs = 10_000;

type Layer = { repository: string; number: number; branch: string; head: string; watch?: PullRequestWatch | null };
type Owed = { pr: string; step: string };
type GitIn = (args: string[], answers?: number[]) => Promise<{ code: number; stdout: string }>;

export const realGit: Git = async (cwd, args) => {
  const child = Bun.spawn(["git", "--no-optional-locks", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout: stdout.trim() };
};

const realProcesses: ProcessTable = {
  pid: process.pid,
  table: async () => {
    const child = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,comm="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [table, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`ps exited ${code}`);
    return table;
  },
};

const gitIn = (run: Git, cwd: string): GitIn => async (args, answers = [0]) => {
  const result = await run(cwd, args);
  if (!answers.includes(result.code)) throw new Error(`git ${args[0]} exited ${result.code}`);
  return result;
};

const isProvider = (command: string) => ["claude", "codex"].includes(command.split("/").at(-1) ?? "");

function nestedSession(table: string, pid: number): boolean {
  const parents = new Map(table.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [[Number(match[1]), { ppid: Number(match[2]), command: match[3]! }] as const] : [];
  }));
  let providers = 0;
  for (let current = parents.get(pid), steps = 0; current && steps < 64; current = parents.get(current.ppid), steps++) {
    if (isProvider(current.command) && ++providers > 1) return true;
  }
  return false;
}

const awaitsCi = ({ watch, head }: Layer) => Boolean(watch)
  && (watch!.headSha !== head || (!watch!.passed && !watch!.failedChecks?.length) || Boolean(watch!.awaitingApproval?.length));

const isAncestor = async (git: GitIn, commit: string, of: string) => (await git(["merge-base", "--is-ancestor", commit, of], [0, 1])).code === 0;

async function layersOf(threads: ShellThread[], threadId: string, git: GitIn): Promise<Layer[]> {
  const origin = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec((await git(["config", "--get", "remote.origin.url"], [0, 1])).stdout)?.[1]?.toLowerCase();
  if (!origin) return [];
  const layers: Layer[] = [];
  for (const pr of ownedPullRequests(threads, threadId)) {
    const [, repository, number] = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(pr.url) ?? [];
    const branch = pr.snapshot?.headBranch;
    if (!repository || !number || !branch || repository.toLowerCase() !== origin) continue;
    const remote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`], [0, 1]);
    if (remote.code === 0) layers.push({ repository, number: Number(number), branch, head: remote.stdout, watch: pr.watch });
  }
  return layers;
}

async function gateRecord(home: string, layer: Layer) {
  const record = await readJson<unknown>(gateRecordPath(home, { repository: layer.repository, pr: layer.number, commit: layer.head }), undefined);
  if (record === undefined) return undefined;
  const { code, reason } = (record ?? {}) as { code?: unknown; reason?: unknown };
  if (!Number.isInteger(code) || typeof reason !== "string") throw new Error("Malformed gate record");
  return { code: code as number, reason };
}

const gateAt = ({ repository, number }: Layer, commit: string) => `fleet proof gate --repo ${repository} --pr ${number} --commit ${commit}`;
const nameOf = ({ repository, number }: Layer) => `${repository}#${number}`;

async function owedStep(layer: Layer, git: GitIn, checkedOut: string | undefined, home: string): Promise<string | undefined> {
  const { branch, head } = layer;
  const name = nameOf(layer);
  if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], [0, 1])).code === 0) {
    const ahead = Number((await git(["rev-list", "--count", `refs/remotes/origin/${branch}..refs/heads/${branch}`])).stdout);
    if (ahead > 0) {
      const local = (await git(["rev-parse", `refs/heads/${branch}`])).stdout;
      return `${name} has ${ahead} local commit(s) on ${branch} past its pushed head. Run git push origin ${branch}, then ${gateAt(layer, local)}`;
    }
  }
  if (checkedOut === branch && (await git(["status", "--porcelain", "--untracked-files=no"])).stdout) {
    return `${name} has uncommitted changes to tracked files on ${branch}. Commit and push them, then run ${gateAt(layer, "<full sha of the new head>")}; or restore them`;
  }
  const record = await gateRecord(home, layer);
  if (!record) return `${name} has no gate run at its pushed head ${head.slice(0, 7)}. Run ${gateAt(layer, head)}`;
  if (record.code === 0) return undefined;
  const next = record.code === 3
    ? ` Decide each gap by tier with fleet decision record --mark 🤖, or ask ${personName(home)} with the question tool, naming the PR, and record the answer with fleet decision record --mark 👤 --class proof-gap --kind <kind> --pr ${name}; then run ${gateAt(layer, head)} again`
    : ` Fix it, then run ${gateAt(layer, head)} again`;
  return `${name}: the last gate run at its pushed head ${head.slice(0, 7)} exited ${record.code}: ${record.reason}.${next}`;
}

async function detachedStep(layers: Layer[], git: GitIn, worktreePath: string | null | undefined): Promise<Owed | undefined> {
  if (!worktreePath) return undefined;
  const top = (await git(["rev-parse", "--show-toplevel"])).stdout;
  if ((await realpath(top)) !== (await realpath(worktreePath).catch(() => worktreePath))) return undefined;
  const here = (await git(["rev-parse", "HEAD"])).stdout;
  for (const layer of layers) if (await isAncestor(git, here, layer.head)) return undefined;
  let continued = layers[0]!;
  for (const layer of layers) if (await isAncestor(git, layer.head, here)) continued = layer;
  return {
    pr: nameOf(continued),
    step: `${nameOf(continued)}: this worktree has a detached HEAD ${here.slice(0, 7)} past its pushed head. Push its commits with git push origin HEAD:refs/heads/${continued.branch}, then run ${gateAt(continued, here)}`,
  };
}

const waitsInClaude = (event: ProofStopEvent) =>
  Boolean(event.background_tasks?.some((task) => ["running", "pending"].includes(task.status ?? "") && task.type !== "shell") || event.session_crons?.length);

export async function proofStop(event: ProofStopEvent, options: ProofStopOptions): Promise<ProofStopBlock | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = options.deadline?.() ?? new Promise<void>((resolve) => { timer = setTimeout(resolve, proofStopDeadlineMs); });
  try {
    return await Promise.race([check(event, options).catch(() => undefined), deadline.then(() => undefined)]);
  } finally {
    clearTimeout(timer);
  }
}

async function check(event: ProofStopEvent, options: ProofStopOptions): Promise<ProofStopBlock | undefined> {
  const { threadId, home } = options;
  if (event.stop_hook_active || !threadId || !event.cwd || waitsInClaude(event) || needsHuman(event.last_assistant_message ?? "")) return undefined;
  const processes = options.processes ?? realProcesses;
  if (nestedSession(await processes.table(), processes.pid)) return undefined;
  const { threads } = await options.shell();
  const thread = matchThread(threads, threadId, (item) => item.id);
  if (!thread || thread.delegatedFrom || thread.pendingRuntimeRequest || isWaiting(thread)) return undefined;
  const git = gitIn(options.git ?? realGit, event.cwd);
  const layers = await layersOf(threads, thread.id, git);
  if (!layers.length || layers.some(awaitsCi)) return undefined;
  const symbolic = await git(["symbolic-ref", "-q", "--short", "HEAD"], [0, 1]);
  const checkedOut = symbolic.code === 0 ? symbolic.stdout : undefined;
  const detached = checkedOut === undefined ? await detachedStep(layers, git, thread.worktreePath) : undefined;
  const owed: Owed[] = detached ? [detached] : [];
  for (const layer of layers) {
    if (owed.some((item) => item.pr === nameOf(layer))) continue;
    const step = await owedStep(layer, git, checkedOut, home);
    if (step) owed.push({ pr: nameOf(layer), step });
  }
  const [first, ...rest] = owed;
  if (!first) return undefined;
  const person = personName(home);
  const others = rest.length ? ` Also owed: ${rest.map((item) => item.pr).join(", ")}.` : "";
  return {
    decision: "block",
    reason: `Fleet blocked this stop: your PR is not proven. ${first.step}.${others} If you are parking for ${person}, ask with the question tool or end with a \`NEEDS_HUMAN:\` line. `
      + `If this turn only answered ${person} and the work is not finished, say what is still owed and end the turn again.`,
  };
}
