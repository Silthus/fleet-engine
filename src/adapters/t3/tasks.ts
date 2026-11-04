import { resolve } from "node:path";
import type { Plan } from "../../pack/types.ts";
import { taskPrefix, type FleetTask, type T3Tasks } from "../jobs/adapter.ts";
import { same } from "../provider-config/fields.ts";
import type { CommandRunner } from "../run.ts";
import type { ModelSelection, T3Rpc, T3Server } from "./port.ts";
import { readT3Settings } from "./settings.ts";

export type Models = (role: string) => ModelSelection | undefined;
export type ShellProject = { id: string; workspaceRoot: string; deletedAt?: string | null };

type ScheduledTask = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: FleetTask["schedule"];
  projectId: string;
  workspaceStrategy: { type: string };
  modelSelection: ModelSelection;
  runtimeMode: FleetTask["runtimeMode"];
};

export async function activeProjects(rpc: T3Rpc): Promise<ShellProject[]> {
  const shell = await rpc.get<{ projects: ShellProject[] }>("/api/orchestration/shell");
  return shell.projects.filter((project) => !project.deletedAt);
}

/** The T3Tasks client the Jobs adapter expects, over the server's scheduledTasks RPCs. Each call opens its own short session. */
export function t3Tasks(server: T3Server, home: string, options: { plan: Plan; run: CommandRunner; models?: Models }): T3Tasks {
  const roles = new Map<string, string>(options.plan.jobs.flatMap((job) => (job.task ? [[`${taskPrefix}${job.id}`, job.task.modelRole]] : [])));
  const fallback = async (rpc: T3Rpc) => (await readT3Settings(rpc)).defaultModelSelection as ModelSelection | undefined;
  const modelOf = async (rpc: T3Rpc, role: string) => options.models?.(role) ?? (await fallback(rpc));
  return {
    list: () =>
      server.session(home, async (rpc) => {
        const { tasks } = await rpc.first<{ tasks: ScheduledTask[] }>("scheduledTasks.subscribe", {});
        const roots = new Map((await activeProjects(rpc)).map((project) => [project.id, project.workspaceRoot]));
        const usual = tasks.some((task) => roles.has(task.id)) ? await fallback(rpc) : undefined;
        return tasks.map((task) => {
          const role = roles.get(task.id);
          const expected = role === undefined ? undefined : (options.models?.(role) ?? usual);
          return {
            id: task.id,
            title: task.title,
            prompt: task.prompt,
            enabled: task.enabled,
            schedule: task.schedule,
            project: roots.get(task.projectId) ?? task.projectId,
            modelRole: role !== undefined && same(task.modelSelection, expected) ? role : `model:${task.modelSelection.instanceId}/${task.modelSelection.model}`,
            workspaceStrategy: task.workspaceStrategy.type as FleetTask["workspaceStrategy"],
            runtimeMode: task.runtimeMode,
          };
        });
      }),
    upsert: (task) =>
      server.session(home, async (rpc) => {
        const project = (await activeProjects(rpc)).find((item) => resolve(item.workspaceRoot) === resolve(task.project));
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
          workspaceStrategy: { type: "worktree", baseRef: await baseRef(options.run, task.project), startFromOrigin: true },
          modelSelection,
          runtimeMode: task.runtimeMode,
          interactionMode: "default",
        });
      }),
    setEnabled: (id, enabled) => server.session(home, async (rpc) => void (await rpc.call("scheduledTasks.setEnabled", { id, enabled }))),
  };
}

async function baseRef(run: CommandRunner, project: string) {
  const head = await run(["git", "-C", project, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : "main";
}
