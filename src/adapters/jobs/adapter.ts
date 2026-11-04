import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Finding, Owned, PackJob, Plan } from "../../pack/types.ts";
import type { Adapter, AdapterResult } from "../../reconciler/apply.ts";
import { sourceOutage } from "../provider-config/adapter.ts";
import { inside } from "../../files/install.ts";
import { linkOnPath, readState, withLock, writeWithBackups, type Write } from "../provider-config/store.ts";
import { isAccountHome, spawnRunner, type CommandRunner } from "../run.ts";
import { cronLine, cronSafe, reconcileCrontab } from "./cron.ts";
import { labelPrefix, plist } from "./launchd.ts";
import { agentCopyTarget, launcherScript, launcherTarget, logTarget } from "./launcher.ts";
import { cronExpression, launchdTimer, t3Schedule, type T3Schedule } from "./schedule.ts";

export type FleetTask = {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: T3Schedule;
  project: string;
  modelRole: string;
  workspaceStrategy: "worktree";
  runtimeMode: NonNullable<PackJob["task"]>["runtimeMode"];
};

export type T3Tasks = { list(): Promise<FleetTask[]>; upsert(task: FleetTask): Promise<void>; setEnabled(id: string, enabled: boolean): Promise<void> };

export type JobsOptions = { run?: CommandRunner; engineRoot?: string; uid?: number; t3?: () => Promise<T3Tasks | undefined> };

export const taskPrefix = "fleet:";
const notFound = 113;
const jobId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function jobsAdapter(options: JobsOptions = {}): Adapter {
  const run = options.run ?? spawnRunner;
  const engineRoot = options.engineRoot ?? join(import.meta.dir, "..", "..", "..");
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const t3 = options.t3 ?? (async () => undefined);
  return {
    name: "jobs",
    targets: () => [],
    async apply(plan, { home, dryRun }) {
      const result: AdapterResult = { actions: [], findings: [] };
      const osJobs = plan.jobs.filter((job) => job.runner !== "t3");
      for (const job of plan.jobs) if (!jobId.test(job.id)) throw new Error(`job id ${job.id} of the ${job.pack} pack may hold only letters, digits, dots, dashes, and underscores`);
      if (!options.run && !isAccountHome(home)) return result;
      const command = (job: PackJob) => (job.command[0] === "fleet" ? ["/bin/sh", join(engineRoot, "fleet"), ...job.command.slice(1)] : job.command);
      const context = { home, dryRun, run, result, outage: sourceOutage(plan) };
      const reconcile = async () => {
        const path = [`${home}/.local/bin`, `${home}/.bun/bin`, ...(plan.os === "darwin" ? ["/opt/homebrew/bin"] : []), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
        const scripts = await launchers(home, osJobs, (job) => launcherScript(command(job), path, inside(home, logTarget(job.id))));
        if (plan.os === "linux") await reconcileCron(osJobs, scripts, context);
        else await reconcileLaunchd(osJobs, scripts, { ...context, uid });
        await reconcileTasks(plan, await t3(), context);
        return result;
      };
      return dryRun ? reconcile() : withLock(home, reconcile);
    },
  };
}

type Context = { home: string; dryRun: boolean; run: CommandRunner; result: AdapterResult; outage: boolean };
type Scripts = Map<string, Write>;

function needs(job: { id: string; pack: string } | string, what: string, kind = "job"): Finding {
  const id = typeof job === "string" ? job : job.id;
  return { id: `${kind}:${id}`, pack: typeof job === "string" ? "engine" : job.pack, say: `The ${id} ${kind} needs to be ${what}.`, repair: "apply" };
}

async function launchers(home: string, jobs: Array<Owned<PackJob>>, script: (job: PackJob) => string): Promise<Scripts> {
  const scripts: Scripts = new Map();
  for (const job of jobs) scripts.set(job.id, { target: launcherTarget(job.id), before: await readState(home, launcherTarget(job.id)), after: script(job) });
  return scripts;
}

const stale = (script: Write | undefined) => script !== undefined && script.before !== script.after;

async function writeLaunchers(home: string, writes: Write[], result: AdapterResult) {
  if (!writes.length) return;
  await writeWithBackups(home, writes);
  result.actions.push(...writes.map((write) => ({ target: write.target, operation: write.before === undefined ? ("create" as const) : ("replace" as const) })));
}

async function removeLauncher(home: string, id: string) {
  if (!(await linkOnPath(home, launcherTarget(id)))) await rm(inside(home, launcherTarget(id)), { force: true });
}

async function reconcileCron(jobs: Array<Owned<PackJob>>, scripts: Scripts, { home, dryRun, run, result, outage }: Context) {
  const listed = await run(["crontab", "-l"]);
  const empty = listed.code !== 0 && /no crontab/i.test(listed.stderr ?? "");
  if (listed.code !== 0 && !empty) {
    if (!jobs.length) return;
    const reason = listed.code === 127 ? "cron is not installed" : (listed.stderr ?? "").trim() || `exit ${listed.code}`;
    result.findings.push({ id: "jobs:cron", pack: "engine", say: `Could not read your crontab (${reason}), so jobs were not changed.`, repair: "human" });
    return;
  }
  if (jobs.length && !cronSafe(home)) {
    result.findings.push({ id: "jobs:cron", pack: "engine", say: `Left jobs alone: cron cannot run scripts from ${JSON.stringify(home)}, which holds a percent sign or a line break.`, repair: "human" });
    return;
  }
  const wanted = new Map(jobs.map((job) => [job.id, cronLine(job.id, cronExpression(job.schedule), inside(home, launcherTarget(job.id)))]));
  const changes = reconcileCrontab(empty ? "" : listed.stdout, wanted, outage);
  const owner = (id: string) => jobs.find((job) => job.id === id) ?? id;
  const rewritten = jobs.filter((job) => stale(scripts.get(job.id)) && !changes.added.includes(job.id) && !changes.changed.includes(job.id)).map((job) => job.id);
  const all = [...changes.added.map((id) => needs(owner(id), "added")), ...[...changes.changed, ...rewritten].map((id) => needs(owner(id), "updated")), ...changes.removed.map((id) => needs(id, "removed"))];
  if (!all.length) return;
  if (dryRun) return void result.findings.push(...all);
  await writeLaunchers(home, [...scripts.values()].filter(stale), result);
  if (!changes.added.length && !changes.changed.length && !changes.removed.length) return;
  const written = await run(["crontab", "-"], { input: changes.text });
  if (written.code !== 0) return void result.findings.push({ id: "jobs:cron", pack: "engine", say: `Could not write your crontab (exit ${written.code}).`, repair: "apply" });
  const kept = new Set([...changes.text.matchAll(/# fleet:([A-Za-z0-9._-]+)$/gm)].map((match) => match[1]!));
  for (const id of new Set(changes.removed)) if (!kept.has(id)) await removeLauncher(home, id);
  result.actions.push({ target: "crontab", operation: "replace", reason: all.map((finding) => finding.say).join(" ") });
}

async function reconcileLaunchd(jobs: Array<Owned<PackJob>>, scripts: Scripts, { home, dryRun, run, result, uid, outage }: Context & { uid: number }) {
  const agents = join(home, "Library/LaunchAgents");
  const domain = `gui/${uid}`;
  const present = (await readdir(agents).catch(() => [] as string[])).filter((name) => name.startsWith(labelPrefix) && name.endsWith(".plist"));
  const state = async (label: string) => {
    const { code } = await run(["launchctl", "print", `${domain}/${label}`]);
    return code === 0 ? "loaded" : code === notFound ? "absent" : `launchctl print exit ${code}`;
  };
  const written = async (id: string) => (jobId.test(id) ? await readState(home, agentCopyTarget(id)).catch(() => undefined) : undefined);
  const foreign = async (name: string, id: string, text: string | undefined, wanted?: string, pack = "engine") => {
    if (text === undefined || text === wanted || text === (await written(id))) return false;
    result.findings.push({ id: `job:${id}`, pack, say: `Left Library/LaunchAgents/${name} alone: Fleet did not write it, or it changed since. Move it away, then run fleet apply.`, repair: "human" });
    return true;
  };
  const keepCopy = async (id: string, content: string) => {
    if (await linkOnPath(home, agentCopyTarget(id))) return;
    await mkdir(dirname(inside(home, agentCopyTarget(id))), { recursive: true });
    await writeFile(inside(home, agentCopyTarget(id)), content);
  };
  const stop = async (job: { id: string; pack: string } | string, label: string) => {
    await run(["launchctl", "bootout", `${domain}/${label}`]);
    const after = await state(label);
    if (after === "absent") return true;
    const id = typeof job === "string" ? job : job.id;
    const say = after === "loaded" ? `launchd did not stop the ${id} job, so Fleet left its agent as it is.` : `Could not check that launchd stopped the ${id} job (${after}), so Fleet left its agent as it is.`;
    result.findings.push({ id: `job:${id}`, pack: typeof job === "string" ? "engine" : job.pack, say, repair: "apply" });
    return false;
  };
  for (const job of jobs) {
    const label = `${labelPrefix}${job.id}`;
    const name = `${label}.plist`;
    const file = join(agents, name);
    const script = scripts.get(job.id)!;
    const content = plist(job.id, inside(home, script.target), launchdTimer(job.schedule), inside(home, logTarget(job.id)));
    const current = await readFile(file, "utf8").catch(() => undefined);
    if (await foreign(name, job.id, current, content, job.pack)) continue;
    const reload = current !== content || (await state(label)) !== "loaded";
    if (!reload && !stale(script)) continue;
    if (dryRun) {
      result.findings.push(needs(job, current === undefined ? "added" : current === content && !stale(script) ? "loaded" : "updated"));
      continue;
    }
    if (reload && current !== undefined && !(await stop(job, label))) continue;
    await writeLaunchers(home, stale(script) ? [script] : [], result);
    if (!reload) continue;
    await mkdir(agents, { recursive: true });
    await writeFile(file, content);
    await keepCopy(job.id, content);
    if ((await run(["launchctl", "bootstrap", domain, file])).code !== 0) result.findings.push({ id: `job:${job.id}`, pack: job.pack, say: `launchd did not load the ${job.id} job.`, repair: "apply" });
    result.actions.push({ target: `Library/LaunchAgents/${name}`, operation: current === undefined ? "create" : "replace" });
  }
  for (const name of present) {
    const label = name.slice(0, -".plist".length);
    const id = label.slice(labelPrefix.length);
    if (outage || jobs.some((job) => `${labelPrefix}${job.id}` === label)) continue;
    if (await foreign(name, id, await readFile(join(agents, name), "utf8").catch(() => undefined))) continue;
    if (dryRun) {
      result.findings.push(needs(id, "removed"));
      continue;
    }
    if (!(await stop(id, label))) continue;
    await rm(join(agents, name), { force: true });
    if (jobId.test(id)) await removeLauncher(home, id);
    if (jobId.test(id) && !(await linkOnPath(home, agentCopyTarget(id)))) await rm(inside(home, agentCopyTarget(id)), { force: true });
    result.actions.push({ target: `Library/LaunchAgents/${name}`, operation: "remove" });
  }
}

async function reconcileTasks(plan: Plan, client: T3Tasks | undefined, { dryRun, result, outage }: Context) {
  const jobs = plan.jobs.filter((job) => job.runner === "t3" && job.task);
  if (!client) {
    for (const job of jobs) result.findings.push({ id: `task:${job.id}`, pack: job.pack, say: `The ${job.id} task waits for T3 Code to run. The next fleet apply after T3 Code starts adds it.`, repair: "apply" });
    return;
  }
  const existing = await client.list();
  for (const job of jobs) {
    const task = job.task!;
    if (task.project === undefined) {
      result.findings.push({ id: `task:${job.id}`, pack: job.pack, say: `The ${job.id} task needs a project. Set it with fleet set ${task.projectSetting}=<path>.`, repair: "human" });
      continue;
    }
    const wanted: FleetTask = { id: `${taskPrefix}${job.id}`, title: `Fleet: ${job.id}`, prompt: task.prompt, enabled: true, schedule: t3Schedule(job.schedule), project: task.project, modelRole: task.modelRole, workspaceStrategy: task.workspaceStrategy, runtimeMode: task.runtimeMode };
    const current = existing.find((item) => item.id === wanted.id);
    if (current && Bun.deepEquals(current, wanted)) continue;
    if (dryRun) {
      result.findings.push(needs(job, current ? "updated" : "added", "task"));
      continue;
    }
    await client.upsert(wanted);
    result.actions.push({ target: `t3 task ${wanted.id}`, operation: current ? "replace" : "create" });
  }
  for (const task of existing) {
    if (outage || !task.id.startsWith(taskPrefix) || !task.enabled || jobs.some((job) => `${taskPrefix}${job.id}` === task.id)) continue;
    if (dryRun) {
      result.findings.push(needs(task.id.slice(taskPrefix.length), "turned off", "task"));
      continue;
    }
    await client.setEnabled(task.id, false);
    result.actions.push({ target: `t3 task ${task.id}`, operation: "remove", reason: "turned off" });
  }
}
