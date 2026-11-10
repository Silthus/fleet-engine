import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ModelRow, PackJob, Plan } from "../../pack/types.ts";
import { taskPrefix, type FleetTask, type T3Tasks } from "../jobs/adapter.ts";
import { same } from "../provider-config/fields.ts";
import type { CommandRunner } from "../run.ts";
import type { ModelSelection, T3Rpc, T3Server } from "./port.ts";
import { readT3Settings } from "./settings.ts";

const instances = { claude: { instanceId: "claudeAgent", effort: "effort" }, codex: { instanceId: "codex", effort: "reasoningEffort" } } as const;

export function modelSelection(models: ModelRow[], role: string): ModelSelection | undefined {
  const row = models.find((item) => item.role === role);
  if (!row) return undefined;
  const instance = instances[row.provider];
  return { instanceId: instance.instanceId, model: row.model, options: [{ id: instance.effort, value: row.effort }] };
}

export type ShellProject = { id: string; workspaceRoot: string; deletedAt?: string | null };

type ScheduledTask = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: FleetTask["schedule"];
  projectId: string;
  workspaceStrategy: { type: string; baseRef?: string; startFromOrigin?: boolean };
  modelSelection: ModelSelection;
  runtimeMode: FleetTask["runtimeMode"];
};

export async function activeProjects(rpc: T3Rpc): Promise<ShellProject[]> {
  const shell = await rpc.get<{ projects: ShellProject[] }>("/api/orchestration/shell");
  return shell.projects.filter((project) => !project.deletedAt);
}

export const expandHome = (home: string, path: string) => (path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path);

export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function t3Tasks(server: T3Server, home: string, options: { plan: Plan; run: CommandRunner }): T3Tasks {
  const jobs = new Map<string, NonNullable<PackJob["task"]>>(options.plan.jobs.flatMap((job) => (job.task ? [[`${taskPrefix}${job.id}`, job.task]] : [])));
  const fallback = async (rpc: T3Rpc) => (await readT3Settings(rpc)).defaultModelSelection as ModelSelection | undefined;
  const planned = (role: string) => modelSelection(options.plan.models, role);
  const modelOf = async (rpc: T3Rpc, role: string) => planned(role) ?? (await fallback(rpc));
  const local = (path: string) => realPath(expandHome(home, path));
  const strategy = async (root: string) => {
    const base = await baseRef(options.run, root);
    if (!base) throw new Error(`${root} has no main or master branch to start worktrees from. Push one, then run fleet apply.`);
    return { type: "worktree", baseRef: base, startFromOrigin: true };
  };
  return {
    list: () =>
      server.session(home, async (rpc) => {
        const { tasks } = await rpc.first<{ tasks: ScheduledTask[] }>("scheduledTasks.subscribe", {});
        const roots = new Map((await activeProjects(rpc)).map((project) => [project.id, project.workspaceRoot]));
        const usual = tasks.some((task) => jobs.has(task.id)) ? await fallback(rpc) : undefined;
        return Promise.all(
          tasks.map(async (task) => {
            const job = jobs.get(task.id);
            const root = roots.get(task.projectId);
            const expected = job === undefined ? undefined : (planned(job.modelRole) ?? usual);
            const project = job?.project !== undefined && root !== undefined && local(job.project) === realPath(root) ? job.project : (root ?? task.projectId);
            const wantedStrategy = job === undefined || root === undefined ? undefined : await strategy(root).catch(() => undefined);
            return {
              id: task.id,
              title: task.title,
              prompt: task.prompt,
              enabled: task.enabled,
              schedule: task.schedule,
              project,
              modelRole: job !== undefined && same(task.modelSelection, expected) ? job.modelRole : `model:${task.modelSelection.instanceId}/${task.modelSelection.model}`,
              workspaceStrategy: (wantedStrategy === undefined || same(task.workspaceStrategy, wantedStrategy) ? task.workspaceStrategy.type : JSON.stringify(task.workspaceStrategy)) as FleetTask["workspaceStrategy"],
              runtimeMode: task.runtimeMode,
            };
          }),
        );
      }),
    upsert: (task) =>
      server.session(home, async (rpc) => {
        const project = (await activeProjects(rpc)).find((item) => realPath(item.workspaceRoot) === local(task.project));
        if (!project) throw new Error(`T3 Code has no project at ${task.project}, so Fleet cannot add the ${task.id} task. Run fleet apply again once T3 Code lists the project.`);
        const modelSelection = await modelOf(rpc, task.modelRole);
        if (!modelSelection) throw new Error(`T3 Code has no default model, so Fleet cannot add the ${task.id} task. Pick a model in T3 Code, then run fleet apply.`);
        await rpc.call("scheduledTasks.upsert", {
          id: task.id,
          title: task.title,
          prompt: task.prompt,
          enabled: task.enabled,
          schedule: task.schedule,
          projectId: project.id,
          workspaceStrategy: await strategy(project.workspaceRoot),
          modelSelection,
          runtimeMode: task.runtimeMode,
          interactionMode: "default",
        });
      }),
    setEnabled: (id, enabled) => server.session(home, async (rpc) => void (await rpc.call("scheduledTasks.setEnabled", { id, enabled }))),
  };
}

async function baseRef(run: CommandRunner, root: string) {
  const git = (...args: string[]) => run(["git", "-C", root, ...args]);
  const exists = async (ref: string) => (await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).code === 0;
  const remotes = await git("remote");
  const names = remotes.code === 0 ? remotes.stdout.split("\n").map((name) => name.trim()).filter(Boolean) : [];
  const remote = names.includes("origin") ? "origin" : names[0];
  if (remote) {
    const head = await git("symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`);
    const remoteDefault = head.code === 0 && head.stdout.trim().startsWith(`${remote}/`) ? head.stdout.trim().slice(remote.length + 1) : "";
    for (const branch of [...(remoteDefault ? [remoteDefault] : []), "main", "master"]) if (await exists(`refs/remotes/${remote}/${branch}`)) return `${remote}/${branch}`;
  }
  for (const branch of ["main", "master"]) if (await exists(`refs/heads/${branch}`)) return branch;
  return undefined;
}
