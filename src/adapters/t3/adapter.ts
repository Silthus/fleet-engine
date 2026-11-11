import { existsSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import type { Finding, Plan } from "../../pack/types.ts";
import type { Adapter, AdapterResult } from "../../reconciler/apply.ts";
import type { T3Tasks } from "../jobs/adapter.ts";
import { sourceOutage } from "../provider-config/adapter.ts";
import { withLock } from "../provider-config/store.ts";
import { skipOtherHome, spawnRunner, type CommandRunner } from "../run.ts";
import type { T3Rpc, T3Server } from "./port.ts";
import { reconcileService } from "./service.ts";
import { reconcileScripts, settingProblems, waitingScripts } from "./scripts.ts";
import { localT3Server } from "./session.ts";
import { desktopTarget, reconcileSettings, settingsFields, settingsTarget } from "./settings.ts";
import { activeProjects, expandHome, realPath, t3Tasks } from "./tasks.ts";

export { desktopTarget, recordTarget, settingsTarget } from "./settings.ts";

export type T3Options = { run?: CommandRunner; accountHome?: () => Promise<string | undefined>; server?: T3Server; user?: string };
export type T3Adapter = Adapter & { tasks(): Promise<T3Tasks | undefined> };

type Link = { environmentId: string; label: string; status: "reachable" | "unreachable" | "expired"; lastError: string | null };

const finding = (id: string, say: string, repair?: Finding["repair"]): Finding => ({ id: `t3:${id}`, pack: "engine", say, ...(repair ? { repair } : {}) });

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
      const skipped = await skipOtherHome("t3", "T3 Code", home, options);
      if (skipped) return skipped;
      const reconcile = async () => {
        const settings = { adopt, dryRun, outage: sourceOutage(plan) };
        const seeded = !(await server.answering(home));
        if (seeded) merge(result, await reconcileSettings(plan, home, settings));
        if (plan.os === "linux") await reconcileService(run, user, dryRun, result);
        result.findings.push(...settingProblems(plan));
        if (!(await server.answering(home))) {
          if (!seeded) merge(result, await reconcileSettings(plan, home, settings));
          const waiting = [...new Set(taskProjects(plan).map((item) => item.path))];
          if (waiting.length) result.findings.push(finding("projects", `T3 Code is not running, so ${waiting.join(", ")} ${waiting.length === 1 ? "waits to be added as a project" : "wait to be added as projects"}. The next fleet apply after T3 Code starts adds ${waiting.length === 1 ? "it" : "them"}.`, "apply"));
          result.findings.push(...waitingScripts(plan));
          return result;
        }
        try {
          await server.session(home, async (rpc) => {
            merge(result, await reconcileSettings(plan, home, { ...settings, rpc }));
            await reconcileProjects(rpc, plan, home, run, dryRun, result);
            await reconcileScripts(rpc, plan, home, dryRun, result);
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

type Owner = { who: string; off: string };
type Wanted = { path: string; owners: Owner[] };

const switchOf = (item: { pack: string; workflow?: string }) => (item.workflow ? `the ${item.workflow} workflow` : `the ${item.pack} pack`);
const listed = (words: string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

function taskProjects(plan: Plan): Wanted[] {
  return plan.jobs.flatMap((job) => (job.runner === "t3" && job.task?.project ? [{ path: job.task.project, owners: [{ who: `the ${job.pack} pack's ${job.id} task`, off: switchOf(job) }] }] : []));
}

function scriptProjects(plan: Plan, home: string): Wanted[] {
  const folder = (path: string) => !path.includes("*") && existsSync(expandHome(home, path)) && statSync(expandHome(home, path)).isDirectory();
  return (plan.t3ProjectScripts ?? []).flatMap((script) => script.projects.filter(folder).map((path) => ({ path, owners: [{ who: `the ${script.pack} pack's ${script.name} script`, off: switchOf(script) }] })));
}

function wantedProjects(plan: Plan, home: string): Wanted[] {
  const byFolder = new Map<string, Wanted>();
  for (const item of [...taskProjects(plan), ...scriptProjects(plan, home)]) {
    const key = realPath(expandHome(home, item.path));
    byFolder.set(key, { path: item.path, owners: [...(byFolder.get(key)?.owners ?? []), ...item.owners] });
  }
  return [...byFolder.values()];
}

function addedNote(path: string, owners: Owner[]) {
  const who = owners.map((owner) => owner.who);
  const off = [...new Set(owners.map((owner) => owner.off))];
  return finding(`project:${path}`, `Fleet added the T3 project ${path}, because ${listed(who)} ${who.length === 1 ? "runs" : "run"} in it. To keep it removed, turn off ${listed(off)}.`);
}

async function reconcileProjects(rpc: T3Rpc, plan: Plan, home: string, run: CommandRunner, dryRun: boolean, result: AdapterResult) {
  const wanted = wantedProjects(plan, home);
  if (!wanted.length) return;
  const active = new Set((await activeProjects(rpc)).map((project) => realPath(project.workspaceRoot)));
  for (const { path, owners } of wanted.filter((item) => !active.has(realPath(expandHome(home, item.path))))) {
    if (dryRun) {
      result.findings.push(finding(`project:${path}`, `T3 Code needs the project ${path}.`, "apply"));
      continue;
    }
    const added = await run(["t3", "project", "add", expandHome(home, path)]);
    if (added.code === 0) {
      result.actions.push({ target: `t3 project ${path}`, operation: "create" });
      result.findings.push(addedNote(path, owners));
    } else if (added.code === 127) result.findings.push(finding(`project:${path}`, `Fleet cannot run t3 to add the project ${path}. Add the folder as a project in T3 Code, then run fleet apply.`, "human"));
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
