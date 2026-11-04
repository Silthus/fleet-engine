import { userInfo } from "node:os";
import { resolve } from "node:path";
import type { Finding, Plan } from "../../pack/types.ts";
import type { Adapter, AdapterResult } from "../../reconciler/apply.ts";
import type { T3Tasks } from "../jobs/adapter.ts";
import { sourceOutage } from "../provider-config/adapter.ts";
import { withLock } from "../provider-config/store.ts";
import { skipOtherHome, spawnRunner, type CommandRunner } from "../run.ts";
import type { T3Rpc, T3Server } from "./port.ts";
import { reconcileService } from "./service.ts";
import { localT3Server } from "./session.ts";
import { desktopTarget, reconcileSettings, settingsFields, settingsTarget } from "./settings.ts";
import { activeProjects, expandHome, t3Tasks } from "./tasks.ts";

export { desktopTarget, recordTarget, settingsTarget } from "./settings.ts";

export type T3Options = { run?: CommandRunner; accountHome?: () => string | undefined; server?: T3Server; user?: string };
export type T3Adapter = Adapter & { tasks(): Promise<T3Tasks | undefined> };

type Link = { environmentId: string; label: string; status: "reachable" | "unreachable" | "expired"; lastError: string | null };

const finding = (id: string, say: string, repair?: Finding["repair"]): Finding => ({ id: `t3:${id}`, pack: "engine", say, ...(repair ? { repair } : {}) });

export async function seedT3(plan: Plan, home: string, options: { adopt?: string[]; dryRun?: boolean } = {}): Promise<AdapterResult> {
  const settings = { adopt: options.adopt ?? [], dryRun: options.dryRun ?? false, outage: sourceOutage(plan) };
  return settings.dryRun ? reconcileSettings(plan, home, settings) : withLock(home, () => reconcileSettings(plan, home, settings));
}

export function t3Adapter(options: T3Options = {}): T3Adapter {
  const run = options.run ?? spawnRunner;
  const server = options.server ?? localT3Server;
  const user = options.user ?? userInfo().username;
  let live: { home: string; plan: Plan } | undefined;
  return {
    name: "t3",
    targets: (plan) => [...(settingsFields(plan).length ? [settingsTarget] : []), ...(plan.os === "darwin" ? [desktopTarget] : [])],
    async apply(plan, { home, dryRun, adopt }) {
      live = undefined;
      const result: AdapterResult = { actions: [], findings: [] };
      const skipped = skipOtherHome("t3", "T3 Code", home, options);
      if (skipped) return skipped;
      const reconcile = async () => {
        if (plan.os === "linux") await reconcileService(run, user, dryRun, result);
        const settings = { adopt, dryRun, outage: sourceOutage(plan) };
        if (!(await server.answering(home))) {
          merge(result, await reconcileSettings(plan, home, settings));
          const waiting = taskProjects(plan);
          if (waiting.length) result.findings.push(finding("projects", `T3 Code is not running, so ${waiting.join(", ")} ${waiting.length === 1 ? "waits to be added as a project" : "wait to be added as projects"}. The next fleet apply after T3 Code starts adds ${waiting.length === 1 ? "it" : "them"}.`, "apply"));
          return result;
        }
        try {
          await server.session(home, async (rpc) => {
            merge(result, await reconcileSettings(plan, home, { ...settings, rpc }));
            await reconcileProjects(rpc, plan, home, run, dryRun, result);
            await checkLinks(rpc, result);
          });
          live = { home, plan };
        } catch (error) {
          result.findings.push(finding("server", `T3 Code did not answer (${(error as Error).message}). Run fleet apply again.`, "apply"));
        }
        return result;
      };
      return dryRun ? reconcile() : withLock(home, reconcile);
    },
    tasks: async () => (live ? t3Tasks(server, live.home, { plan: live.plan, run }) : undefined),
  };
}

function merge(into: AdapterResult, from: AdapterResult) {
  into.actions.push(...from.actions);
  into.findings.push(...from.findings);
}

function taskProjects(plan: Plan) {
  return [...new Set(plan.jobs.flatMap((job) => (job.runner === "t3" && job.task?.project ? [job.task.project] : [])))];
}

async function reconcileProjects(rpc: T3Rpc, plan: Plan, home: string, run: CommandRunner, dryRun: boolean, result: AdapterResult) {
  const wanted = taskProjects(plan);
  if (!wanted.length) return;
  const listed = new Set((await activeProjects(rpc)).map((project) => resolve(project.workspaceRoot)));
  for (const path of wanted.filter((item) => !listed.has(resolve(expandHome(home, item))))) {
    if (dryRun) {
      result.findings.push(finding(`project:${path}`, `T3 Code needs the project ${path}.`, "apply"));
      continue;
    }
    const added = await run(["t3", "project", "add", expandHome(home, path)]);
    if (added.code === 0) result.actions.push({ target: `t3 project ${path}`, operation: "create" });
    else if (added.code === 127) result.findings.push(finding(`project:${path}`, `Fleet cannot run t3 to add the project ${path}. Add the folder as a project in T3 Code, then run fleet apply.`, "human"));
    else result.findings.push(finding(`project:${path}`, `T3 Code did not add the project ${path} (exit ${added.code}). Check that the folder exists, then run fleet apply.`, "apply"));
  }
}

async function checkLinks(rpc: T3Rpc, result: AdapterResult) {
  let links: Link[];
  try {
    links = (await rpc.call<{ links: Link[] }>("peerLinks.list", {})).links;
  } catch (error) {
    return void result.findings.push(finding("links", `Fleet could not read T3 Code's linked environments (${(error as Error).message}).`));
  }
  for (const link of links) {
    if (link.status === "expired") result.findings.push(finding(`link:${link.environmentId}`, `The link to ${link.label} has expired. Link it again in T3 Code: Settings, Environments, Link environment.`, "human"));
    if (link.status === "unreachable") result.findings.push(finding(`link:${link.environmentId}`, `T3 Code cannot reach ${link.label}${link.lastError ? ` (${link.lastError})` : ""}. Check that it is on and online. If it stays unreachable, link it again in T3 Code.`));
  }
}
