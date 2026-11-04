import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { Finding, Owned, PackJob, Plan } from "../../pack/types.ts";
import type { Adapter, AdapterResult } from "../../reconciler/apply.ts";
import { sourceOutage } from "../provider-config/adapter.ts";
import { withLock } from "../provider-config/store.ts";
import { spawnRunner, type CommandRunner } from "../run.ts";
import { cronLine, reconcileCrontab } from "./cron.ts";
import { labelPrefix, plist } from "./launchd.ts";
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

/** The T3 server's scheduled tasks, as the T3 config adapter's client exposes them. */
export type T3Tasks = { list(): Promise<FleetTask[]>; upsert(task: FleetTask): Promise<void>; setEnabled(id: string, enabled: boolean): Promise<void> };

export type JobsOptions = { run?: CommandRunner; engineRoot?: string; uid?: number; t3?: () => Promise<T3Tasks | undefined> };

export const taskPrefix = "fleet:";
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
      const logs = join(home, ".local/state/fleet/jobs");
      const command = (job: PackJob) => (job.command[0] === "fleet" ? ["/bin/sh", join(engineRoot, "fleet"), ...job.command.slice(1)] : job.command);
      if (!options.run && resolve(home) !== resolve(userInfo().homedir)) {
        if (osJobs.length) result.findings.push({ id: "jobs:home", pack: "engine", say: `Left jobs alone: ${home} is not your home directory, and cron and launchd belong to your user.` });
        return result;
      }
      const outage = sourceOutage(plan);
      const context = { home, dryRun, run, logs, command, result, outage };
      const reconcile = async () => {
        if (plan.os === "linux") await reconcileCron(osJobs, context);
        else await reconcileLaunchd(osJobs, { ...context, uid });
        await reconcileTasks(plan, await t3(), context);
        return result;
      };
      return dryRun ? reconcile() : withLock(home, reconcile);
    },
  };
}

type Context = { home: string; dryRun: boolean; run: CommandRunner; logs: string; command(job: PackJob): string[]; result: AdapterResult; outage: boolean };

function needs(job: { id: string; pack: string } | string, what: string, kind = "job"): Finding {
  const id = typeof job === "string" ? job : job.id;
  return { id: `${kind}:${id}`, pack: typeof job === "string" ? "engine" : job.pack, say: `The ${id} ${kind} needs to be ${what}.`, repair: "apply" };
}

async function reconcileCron(jobs: Array<Owned<PackJob>>, { home, dryRun, run, logs, command, result, outage }: Context) {
  const listed = await run(["crontab", "-l"]);
  const empty = listed.code !== 0 && /no crontab/i.test(listed.stderr ?? "");
  if (listed.code !== 0 && !empty) {
    if (!jobs.length) return;
    const reason = listed.code === 127 ? "cron is not installed" : (listed.stderr ?? "").trim() || `exit ${listed.code}`;
    result.findings.push({ id: "jobs:cron", pack: "engine", say: `Could not read your crontab (${reason}), so jobs were not changed.`, repair: "human" });
    return;
  }
  const path = `${home}/.local/bin:${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
  const wanted = new Map(jobs.map((job) => [job.id, cronLine(job.id, cronExpression(job.schedule), command(job), path, join(logs, `${job.id}.log`))]));
  const changes = reconcileCrontab(empty ? "" : listed.stdout, wanted, outage);
  const owner = (id: string) => jobs.find((job) => job.id === id) ?? id;
  const all = [...changes.added.map((id) => needs(owner(id), "added")), ...changes.changed.map((id) => needs(owner(id), "updated")), ...changes.removed.map((id) => needs(id, "removed"))];
  if (!all.length) return;
  if (dryRun) return void result.findings.push(...all);
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const written = await run(["crontab", "-"], { input: changes.text });
  if (written.code !== 0) return void result.findings.push({ id: "jobs:cron", pack: "engine", say: `Could not write your crontab (exit ${written.code}).`, repair: "apply" });
  result.actions.push({ target: "crontab", operation: "replace", reason: all.map((finding) => finding.say).join(" ") });
}

async function reconcileLaunchd(jobs: Array<Owned<PackJob>>, { home, dryRun, run, logs, command, result, uid, outage }: Context & { uid: number }) {
  const agents = join(home, "Library/LaunchAgents");
  const domain = `gui/${uid}`;
  const path = `${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const present = (await readdir(agents).catch(() => [] as string[])).filter((name) => name.startsWith(labelPrefix) && name.endsWith(".plist"));
  const loaded = async (label: string) => (await run(["launchctl", "print", `${domain}/${label}`])).code === 0;
  for (const job of jobs) {
    const label = `${labelPrefix}${job.id}`;
    const file = join(agents, `${label}.plist`);
    const content = plist(job.id, command(job), launchdTimer(job.schedule), path, join(logs, `${job.id}.log`));
    const current = await readFile(file, "utf8").catch(() => undefined);
    if (current === content && (await loaded(label))) continue;
    if (dryRun) {
      result.findings.push(needs(job, current === undefined ? "added" : current === content ? "loaded" : "updated"));
      continue;
    }
    await mkdir(agents, { recursive: true });
    await mkdir(logs, { recursive: true, mode: 0o700 });
    await run(["launchctl", "bootout", `${domain}/${label}`]);
    await writeFile(file, content);
    if ((await run(["launchctl", "bootstrap", domain, file])).code !== 0) result.findings.push({ id: `job:${job.id}`, pack: job.pack, say: `launchd did not load the ${job.id} job.`, repair: "apply" });
    result.actions.push({ target: `Library/LaunchAgents/${label}.plist`, operation: current === undefined ? "create" : "replace" });
  }
  for (const name of present) {
    const label = name.slice(0, -".plist".length);
    if (outage || jobs.some((job) => `${labelPrefix}${job.id}` === label)) continue;
    if (dryRun) {
      result.findings.push(needs(label.slice(labelPrefix.length), "removed"));
      continue;
    }
    await run(["launchctl", "bootout", `${domain}/${label}`]);
    await rm(join(agents, name), { force: true });
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
