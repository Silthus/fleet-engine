import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Finding, Owned, PackJob, Plan } from "../../pack/types.ts";
import type { Adapter, AdapterResult } from "../../reconciler/apply.ts";
import { sourceOutage } from "../provider-config/adapter.ts";
import { inside } from "../../files/install.ts";
import { linkOnPath, readState, withLock, writeWithBackups, type Write } from "../provider-config/store.ts";
import { skipOtherHome, spawnRunner, type CommandRunner } from "../run.ts";
import { cronLine, cronSafe, reconcileCrontab } from "./cron.ts";
import { labelPrefix, plist } from "./launchd.ts";
import { engineCommand } from "../../reconciler/engine-command.ts";
import { agentCopyTarget, jobsFolder, launcherScript, launcherTarget, logTarget } from "./launcher.ts";
import { cronExpression, isService, isTimed, launchdTimer, t3Schedule, type T3Schedule, type TimedJob } from "./schedule.ts";
import { systemdSafe, unit, unitName, unitTarget } from "./systemd.ts";

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

export type JobsOptions = { run?: CommandRunner; accountHome?: () => Promise<string | undefined>; engineRoot?: string; uid?: number; t3?: () => Promise<T3Tasks | undefined> };

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
      const skipped = await skipOtherHome("jobs", "your scheduled jobs", home, options);
      if (skipped) return skipped;
      const command = (job: PackJob) => engineCommand(job.command, engineRoot);
      const context = { home, dryRun, run, result, outage: sourceOutage(plan), gated: new Set(plan.dropped.filter((entry) => entry.check && entry.item.startsWith("job ")).map((entry) => entry.item.slice("job ".length))) };
      const reconcile = async () => {
        const path = [`${home}/.local/bin`, `${home}/.bun/bin`, ...(plan.os === "darwin" ? ["/opt/homebrew/bin"] : []), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
        const scripts = await launchers(home, osJobs, (job) => launcherScript(command(job), path, inside(home, logTarget(job.id))));
        if (plan.os === "linux") {
          const services = osJobs.filter(isService);
          const timed = osJobs.filter(isTimed);
          const moving = new Set(timed.map((job) => job.id));
          const systemd = await reconcileSystemd(services, only(scripts, services), context, moving);
          const cron = await reconcileCron(timed, only(scripts, timed), context, new Set(services.map((job) => job.id)), new Set(services.filter((job) => !systemd.running.has(job.id)).map((job) => job.id)));
          if (cron) await systemd.removeMoved();
        } else await reconcileLaunchd(osJobs, scripts, { ...context, uid });
        await reconcileTasks(plan, await t3(), context);
        return result;
      };
      return dryRun ? reconcile() : withLock(home, reconcile);
    },
  };
}

type Context = { home: string; dryRun: boolean; run: CommandRunner; result: AdapterResult; outage: boolean; gated: Set<string> };
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

const only = (scripts: Scripts, jobs: Array<Owned<PackJob>>): Scripts => new Map(jobs.map((job) => [job.id, scripts.get(job.id)!]));

const stale = (script: Write | undefined) => script !== undefined && script.before !== script.after;

async function writeLaunchers(home: string, writes: Write[], result: AdapterResult) {
  if (!writes.length) return;
  await writeWithBackups(home, writes);
  result.actions.push(...writes.map((write) => ({ target: write.target, operation: write.before === undefined ? ("create" as const) : ("replace" as const) })));
}

async function removeLauncher(home: string, id: string) {
  if (!(await linkOnPath(home, launcherTarget(id)))) await rm(inside(home, launcherTarget(id)), { force: true });
}

async function reconcileCron(jobs: TimedJob[], scripts: Scripts, { home, dryRun, run, result, outage, gated }: Context, keep: Set<string> = new Set(), hold: Set<string> = new Set()): Promise<boolean> {
  const listed = await run(["crontab", "-l"]);
  const empty = listed.code !== 0 && /no crontab/i.test(listed.stderr ?? "");
  if (listed.code !== 0 && !empty) {
    if (!jobs.length) return true;
    const reason = listed.code === 127 ? "cron is not installed" : (listed.stderr ?? "").trim() || `exit ${listed.code}`;
    result.findings.push({ id: "jobs:cron", pack: "engine", say: `Could not read your crontab (${reason}), so jobs were not changed.`, repair: "human" });
    return false;
  }
  if (jobs.length && !cronSafe(home)) {
    result.findings.push({ id: "jobs:cron", pack: "engine", say: `Left jobs alone: cron cannot run scripts from ${JSON.stringify(home)}, which holds a percent sign or a line break.`, repair: "human" });
    return false;
  }
  const wanted = new Map(jobs.map((job) => [job.id, cronLine(job.id, cronExpression(job.schedule), inside(home, launcherTarget(job.id)))]));
  const changes = reconcileCrontab(empty ? "" : listed.stdout, wanted, (id) => (outage && !gated.has(id)) || hold.has(id));
  const owner = (id: string) => jobs.find((job) => job.id === id) ?? id;
  const rewritten = jobs.filter((job) => stale(scripts.get(job.id)) && !changes.added.includes(job.id) && !changes.changed.includes(job.id)).map((job) => job.id);
  const all = [...changes.added.map((id) => needs(owner(id), "added")), ...[...changes.changed, ...rewritten].map((id) => needs(owner(id), "updated")), ...changes.removed.map((id) => needs(id, "removed"))];
  if (!all.length) return true;
  if (dryRun) return result.findings.push(...all), false;
  await writeLaunchers(home, [...scripts.values()].filter(stale), result);
  if (!changes.added.length && !changes.changed.length && !changes.removed.length) return true;
  const written = await run(["crontab", "-"], { input: changes.text });
  if (written.code !== 0) return result.findings.push({ id: "jobs:cron", pack: "engine", say: `Could not write your crontab (exit ${written.code}).`, repair: "apply" }), false;
  const kept = new Set([...changes.text.matchAll(/# fleet:([A-Za-z0-9._-]+)$/gm)].map((match) => match[1]!));
  for (const id of new Set(changes.removed)) if (!kept.has(id) && !keep.has(id)) await removeLauncher(home, id);
  result.actions.push({ target: "crontab", operation: "replace", reason: all.map((finding) => finding.say).join(" ") });
  return true;
}

async function reconcileLaunchd(jobs: Array<Owned<PackJob>>, scripts: Scripts, { home, dryRun, run, result, uid, outage, gated }: Context & { uid: number }) {
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
  const removeCopy = async (id: string) => {
    if (!(await linkOnPath(home, agentCopyTarget(id)))) await rm(inside(home, agentCopyTarget(id)), { force: true });
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
    const content = plist(job.id, inside(home, script.target), isTimed(job) ? launchdTimer(job.schedule) : "always", inside(home, logTarget(job.id)));
    const current = await readFile(file, "utf8").catch(() => undefined);
    if (await foreign(name, job.id, current, content, job.pack)) continue;
    const reload = current !== content || (await state(label)) !== "loaded" || (isService(job) && stale(script));
    if (!dryRun && current === content && (await written(job.id)) !== content) await keepCopy(job.id, content);
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
    if ((outage && !gated.has(id)) || jobs.some((job) => `${labelPrefix}${job.id}` === label)) continue;
    if (await foreign(name, id, await readFile(join(agents, name), "utf8").catch(() => undefined))) continue;
    if (dryRun) {
      result.findings.push(needs(id, "removed"));
      continue;
    }
    if (!(await stop(id, label))) continue;
    await rm(join(agents, name), { force: true });
    if (jobId.test(id)) await Promise.all([removeLauncher(home, id), removeCopy(id)]);
    result.actions.push({ target: `Library/LaunchAgents/${name}`, operation: "remove" });
  }
  if (outage || dryRun || (await linkOnPath(home, jobsFolder))) return;
  const copies = (await readdir(inside(home, jobsFolder)).catch(() => [] as string[])).filter((name) => name.endsWith(".plist")).map((name) => name.slice(0, -".plist".length));
  for (const id of copies) {
    if (!jobId.test(id) || jobs.some((job) => job.id === id) || present.includes(`${labelPrefix}${id}.plist`)) continue;
    await removeLauncher(home, id);
    await removeCopy(id);
  }
}

const running = ["active", "activating", "reloading"];
type Systemd = { running: Set<string>; removeMoved(): Promise<void> };

async function reconcileSystemd(jobs: Array<Owned<PackJob>>, scripts: Scripts, { home, dryRun, run, result, outage, gated }: Context, moving: Set<string>): Promise<Systemd> {
  const copyTarget = (id: string) => `${jobsFolder}/${id}.service`;
  const restartTarget = (id: string) => `${jobsFolder}/${id}.restart`;
  const read = (target: string): Promise<string | undefined | null> => readState(home, target).catch(() => null);
  const systemctl = (...args: string[]) => run(["systemctl", "--user", ...args]);
  const reason = (output: { code: number; stderr?: string }) => (output.stderr ?? "").trim().split("\n").at(-1) || `exit ${output.code}`;
  const ready = new Set<string>();
  const done: Systemd = { running: ready, removeMoved: async () => {} };
  const say = (job: { id: string; pack: string } | string, text: string, repair: Finding["repair"]) => result.findings.push({ id: `job:${typeof job === "string" ? job : job.id}`, pack: typeof job === "string" ? "engine" : job.pack, say: text, repair });
  const foreign = (job: { id: string; pack: string } | string) => say(job, `Left ${unitTarget(typeof job === "string" ? job : job.id)} alone: Fleet did not write it, or it changed since. Move it away, then run fleet apply.`, "human");
  const unreachable = (output: { code: number; stderr?: string }) => (result.findings.push({ id: "jobs:systemd", pack: "engine", say: `Could not reach systemd's user manager (${reason(output)}), so services were not changed. Log in to this machine in a normal session, then run fleet apply.`, repair: "human" }), done);
  const linked = Boolean(await linkOnPath(home, jobsFolder));
  const copies = linked ? [] : (await readdir(inside(home, jobsFolder)).catch(() => [] as string[])).filter((name) => name.endsWith(".service")).map((name) => name.slice(0, -".service".length));
  const gone = copies.filter((id) => jobId.test(id) && !jobs.some((job) => job.id === id) && (!outage || gated.has(id)));
  if (jobs.length && !systemdSafe(home)) return result.findings.push({ id: "jobs:systemd", pack: "engine", say: `Left services alone: systemd cannot run scripts from ${JSON.stringify(home)}, which holds a line break.`, repair: "human" }), done;
  const plans: Array<{ job: Owned<PackJob>; script: Write; content: string; current?: string; copy?: string; reload: boolean; restart: boolean; enable: boolean; pending: boolean; marked?: string }> = [];
  for (const job of jobs) {
    const script = scripts.get(job.id)!;
    const content = unit(job.id, inside(home, script.target));
    const [current, copy, pending] = [await read(unitTarget(job.id)), await read(copyTarget(job.id)), await read(restartTarget(job.id))];
    if (current === null || copy === null || pending === null || (current !== undefined && current !== content && current !== copy)) {
      foreign(job);
      continue;
    }
    const shown = await systemctl("show", "--property=ActiveState,UnitFileState,NeedDaemonReload", unitName(job.id));
    if (shown.code !== 0) return unreachable(shown);
    const state = Object.fromEntries(shown.stdout.split("\n").map((line) => line.split("=", 2) as [string, string]));
    const changed = current !== content || stale(script) || state.NeedDaemonReload === "yes" || pending !== undefined;
    const restart = changed || !running.includes(state.ActiveState ?? "");
    const enable = state.UnitFileState !== "enabled";
    plans.push({ job, script, content, current, copy, reload: current !== content || state.NeedDaemonReload === "yes", restart, enable, pending: changed && running.includes(state.ActiveState ?? ""), marked: pending });
    if (!restart && !enable) ready.add(job.id);
  }
  for (const { job, current, content, restart, enable } of plans) {
    if (dryRun && (restart || enable)) result.findings.push(needs(job, current === undefined ? "added" : current !== content || stale(scripts.get(job.id)) ? "updated" : "started"));
  }
  const leaving: string[] = [];
  const later: string[] = [];
  for (const id of gone) {
    const [current, copy] = [await read(unitTarget(id)), await read(copyTarget(id))];
    if (current === null || copy === null || (current !== undefined && current !== copy)) foreign(id);
    else if (dryRun) result.findings.push(needs(id, "removed"));
    else (moving.has(id) ? later : leaving).push(id);
  }
  if (dryRun) return done;
  const units = plans.filter((item) => item.current !== item.content);
  await writeWithBackups(home, plans.filter((item) => item.pending && item.marked === undefined).map((item) => ({ target: restartTarget(item.job.id), before: undefined, after: "" })));
  await writeLaunchers(home, plans.map((item) => item.script).filter(stale), result);
  if (units.length) await writeWithBackups(home, units.map((item) => ({ target: unitTarget(item.job.id), before: item.current, after: item.content })));
  result.actions.push(...units.map((item) => ({ target: unitTarget(item.job.id), operation: item.current === undefined ? ("create" as const) : ("replace" as const) })));
  await writeWithBackups(home, plans.filter((item) => item.copy !== item.content).map((item) => ({ target: copyTarget(item.job.id), before: item.copy, after: item.content })));
  const remove = async (ids: string[]) => {
    let removed = false;
    for (const id of ids) {
      const present = (await read(unitTarget(id))) !== undefined;
      const stopped = present ? await systemctl("disable", "--now", unitName(id)) : await stopLoaded(id);
      if (stopped.code !== 0) {
        say(id, `systemd did not stop the ${id} job (${reason(stopped)}), so Fleet left its unit as it is.`, "apply");
        continue;
      }
      if (present) {
        await rm(inside(home, unitTarget(id)), { force: true });
        result.actions.push({ target: unitTarget(id), operation: "remove" });
        removed = true;
      }
      await rm(inside(home, copyTarget(id)), { force: true });
      await rm(inside(home, restartTarget(id)), { force: true });
      if (!moving.has(id)) await removeLauncher(home, id);
    }
    return removed;
  };
  const stopLoaded = async (id: string) => {
    const shown = await systemctl("show", "--property=ActiveState", unitName(id));
    if (shown.code !== 0) return shown;
    return running.some((state) => shown.stdout.includes(`ActiveState=${state}`)) ? systemctl("stop", unitName(id)) : shown;
  };
  const reloadNow = async () => {
    const reloaded = await systemctl("daemon-reload");
    if (reloaded.code !== 0) result.findings.push({ id: "jobs:systemd", pack: "engine", say: `systemd did not reload its units (${reason(reloaded)}). Run fleet apply again.`, repair: "apply" });
    return reloaded.code === 0;
  };
  done.removeMoved = async () => void ((await remove(later)) && (await reloadNow()));
  const removed = await remove(leaving);
  if ((plans.some((item) => item.reload) || removed) && !(await reloadNow())) return done;
  for (const { job, restart, enable } of plans) {
    let ok = true;
    for (const [wanted, verb] of [[enable, "enable"], [restart, "restart"]] as const) {
      if (!wanted) continue;
      const answer = await systemctl(verb, unitName(job.id));
      if (answer.code !== 0) ok = false, say(job, `systemd did not ${verb === "enable" ? "enable" : "start"} the ${job.id} job (${reason(answer)}).`, "apply");
      else if (verb === "restart") await rm(inside(home, restartTarget(job.id)), { force: true });
    }
    if (ok) ready.add(job.id);
  }
  return done;
}

async function reconcileTasks(plan: Plan, client: T3Tasks | undefined, { dryRun, result, outage, gated }: Context) {
  const jobs = plan.jobs.filter(isTimed).filter((job) => job.runner === "t3" && job.task);
  if (!client) {
    for (const job of jobs) result.findings.push({ id: `task:${job.id}`, pack: job.pack, say: `The ${job.id} task waits for T3 Code to run. The next fleet apply after T3 Code starts adds it.`, repair: "apply" });
    return;
  }
  let existing: FleetTask[];
  try {
    existing = await client.list();
  } catch (error) {
    result.findings.push({ id: "tasks:t3", pack: "engine", say: `Could not read T3 Code's scheduled tasks: ${(error as Error).message}. Run fleet apply again.`, repair: "apply" });
    return;
  }
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
    try {
      await client.upsert(wanted);
    } catch (error) {
      result.findings.push({ id: `task:${job.id}`, pack: job.pack, say: `Could not add the ${job.id} task to T3 Code: ${(error as Error).message}`, repair: "apply" });
      continue;
    }
    result.actions.push({ target: `t3 task ${wanted.id}`, operation: current ? "replace" : "create" });
  }
  for (const task of existing) {
    if ((outage && !gated.has(task.id.slice(taskPrefix.length))) || !task.id.startsWith(taskPrefix) || !task.enabled || jobs.some((job) => `${taskPrefix}${job.id}` === task.id)) continue;
    if (dryRun) {
      result.findings.push(needs(task.id.slice(taskPrefix.length), "turned off", "task"));
      continue;
    }
    try {
      await client.setEnabled(task.id, false);
    } catch (error) {
      result.findings.push({ id: `task:${task.id.slice(taskPrefix.length)}`, pack: "engine", say: `Could not turn off the ${task.id.slice(taskPrefix.length)} task in T3 Code: ${(error as Error).message}`, repair: "apply" });
      continue;
    }
    result.actions.push({ target: `t3 task ${task.id}`, operation: "remove", reason: "turned off" });
  }
}
