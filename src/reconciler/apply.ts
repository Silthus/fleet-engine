import { install, plan as planFiles } from "../files/install.ts";
import type { Action, CatalogEntry, Finding, HumanStep, Owned, Plan, Report } from "../pack/types.ts";
import { engineCommand } from "./engine-command.ts";
import { hublessReason } from "./resolve.ts";

export type AdapterContext = { home: string; dryRun: boolean; adopt: string[] };
export type AdapterResult = { actions: Action[]; findings: Finding[] };
export type Adapter = {
  name: "files" | "config" | "jobs" | "identity" | "t3";
  /** The targets that --adopt may name for this adapter. */
  targets(plan: Plan): string[];
  apply(plan: Plan, context: AdapterContext): Promise<AdapterResult>;
};
export type Runner = (command: string[]) => Promise<number>;
/** Issues this machine's credential for each served service that lacks one, and reports what failed. */
export type Issuer = (entries: CatalogEntry[], node: string) => Promise<Finding[]>;

export const filesGroup = "fleet";

/**
 * Files keeps whatever it cannot safely change: a local edit or an unmanaged
 * file (a conflict), and during a source outage every file it would replace or
 * remove, because the plan lacks the unreachable packs' parts. Held files keep
 * their ownership record, so a later apply still knows them.
 */
export const filesAdapter: Adapter = {
  name: "files",
  targets: (plan) => plan.files.map((file) => file.target),
  async apply(plan, { home, dryRun, adopt }) {
    const own = adopt.filter((target) => plan.files.some((file) => file.target === target));
    const first = await planFiles(home, plan.files, filesGroup, own);
    const outage = unreachable(plan);
    const parked = outage.length ? first.filter((action) => action.operation === "remove" || action.operation === "replace") : [];
    const kept = first.filter((action) => action.operation === "conflict");
    const hold = [...kept, ...parked].map((action) => action.target);
    const findings: Finding[] = kept.map((action) => ({
      id: `kept:${action.target}`,
      pack: "engine",
      say: `Kept your ${action.target} (${action.reason}). Run fleet apply --adopt ${action.target} to take Fleet's version.`,
    }));
    if (parked.length) {
      findings.push({ id: "outage", pack: "engine", say: `Left ${parked.map((action) => action.target).join(", ")} as they are until ${outage.join(", ")} can be fetched.`, repair: "apply" });
    }
    const preview = hold.length ? await planFiles(home, plan.files, filesGroup, own, [], hold) : first;
    if (dryRun) {
      for (const action of preview.filter((item) => ["create", "replace", "remove"].includes(item.operation))) {
        findings.push({ id: `files:${action.target}`, pack: "engine", say: `${action.target} needs to ${action.operation === "create" ? "be created" : action.operation === "replace" ? "be updated" : "be removed"}.`, repair: "apply" });
      }
      return { actions: [...preview, ...kept], findings };
    }
    const { actions } = await install(home, plan.files, filesGroup, own, [], hold);
    return { actions: [...actions, ...kept], findings };
  },
};

export async function apply(plan: Plan, options: { home: string; dryRun?: boolean; adopt?: string[]; adapters?: Adapter[]; run?: Runner; issue?: Issuer }): Promise<Report> {
  const context = { home: options.home, dryRun: options.dryRun ?? false, adopt: options.adopt ?? [] };
  const adapters = options.adapters ?? [filesAdapter];
  const adoptable = new Set(adapters.flatMap((adapter) => adapter.targets(plan)));
  const unknown = context.adopt.filter((target) => !adoptable.has(target));
  if (unknown.length) throw new Error(`nothing to adopt at ${unknown.join(", ")}: no part of your profile writes it`);
  const report: Report = { ok: true, actions: [], findings: [], humanLeft: [] };
  report.findings.push(...packFindings(plan), ...hubFindings(plan));
  if (plan.unanswered.length) {
    report.ok = false;
    report.findings.push(...plan.unanswered.map((setting) => ({ id: `unanswered:${setting.key}`, pack: setting.key.split(".")[0] ?? "", say: `${setting.question} Answer it with fleet set ${setting.key}=<value>.`, repair: "human" as const })));
    return report;
  }
  const run = viaEngine(plan, options.run ?? spawnRunner(options.home, plan.machine.profileDir));
  const node = plan.onHub ? plan.machine.name : undefined;
  const issue = !context.dryRun && node && options.issue ? (ready: CatalogEntry[]) => options.issue!(ready, node) : undefined;
  const gated = await gate(plan, run, !context.dryRun, issue);
  report.findings.push(...gated.issued, ...gated.failed.map((step) => humanFinding(step, context.dryRun)));
  for (const adapter of adapters) {
    const result = await adapter.apply(gated.plan, context);
    report.actions.push(...result.actions);
    report.findings.push(...result.findings);
  }
  if (context.dryRun) return report;
  const failed = new Set<string>();
  const waits = waiter(plan, run);
  for (const step of plan.steps) {
    if (failed.has(step.pack) || (await waits(step))) continue;
    if (step.check && (await run(step.check)) === 0) continue;
    const ran = (await run(step.run)) === 0;
    if (ran && (!step.check || (await run(step.check)) === 0)) continue;
    failed.add(step.pack);
    report.findings.push({ id: `step:${step.id}`, pack: step.pack, say: ran ? `Step ${step.id} of the ${step.pack} pack ran, but does not pass its check.` : `Step ${step.id} of the ${step.pack} pack failed.`, repair: "apply" });
    if (step.pack === "base") report.ok = false;
  }
  return report;
}

export async function check(plan: Plan, options: { home: string; adapters?: Adapter[]; run?: Runner }): Promise<Report> {
  const run = viaEngine(plan, options.run ?? spawnRunner(options.home, plan.machine.profileDir));
  const report = await apply(plan, { ...options, dryRun: true });
  for (const item of plan.checks) {
    if ((await run(item.run)) !== 0) report.findings.push({ id: `check:${item.id}`, pack: item.pack, say: item.say, repair: "apply" });
  }
  const waits = waiter(plan, run);
  for (const step of plan.steps) {
    if (await waits(step)) continue;
    if (step.check && (await run(step.check)) !== 0) report.findings.push({ id: `step:${step.id}`, pack: step.pack, say: `Step ${step.id} of the ${step.pack} pack does not pass its check.`, repair: "apply" });
  }
  for (const step of plan.human) {
    const reported = report.findings.some((finding) => finding.id === `human:${step.id}` && finding.pack === step.pack);
    if (!reported && (await run(step.probe)) === 0) continue;
    report.humanLeft.push(step);
    if (!reported) report.findings.push(humanFinding(step, true));
  }
  if (report.findings.some((finding) => finding.repair || finding.id.startsWith("kept:"))) report.ok = false;
  return report;
}

function humanFinding(step: Owned<HumanStep>, repairStillToRun: boolean): Finding {
  return { id: `human:${step.id}`, pack: step.pack, say: step.command ? `${step.say} Run: ${step.command}` : step.say, repair: repairStillToRun && step.repair && !step.command ? "apply" : "human" };
}

/** Tests each check once, running a Fleet repair first when one fails and repairs are on, then drops the items whose check fails. It tests the checks that served services wait for first and issues their credentials, so a repair that reads a credential sees it in the same apply. */
async function gate(plan: Plan, run: Runner, repair: boolean, issue?: (ready: CatalogEntry[]) => Promise<Finding[]>): Promise<{ plan: Plan; failed: Array<Owned<HumanStep>>; issued: Finding[] }> {
  const tested = new Map<Owned<HumanStep>, boolean>();
  const probe = async (step: Owned<HumanStep>) => {
    if ((await run(step.probe)) === 0) return true;
    return repair && step.repair !== undefined && (await run(step.repair)) === 0 && (await run(step.probe)) === 0;
  };
  const passes = async (step: Owned<HumanStep> | undefined) => {
    if (!step) return false;
    if (!tested.has(step)) tested.set(step, await probe(step));
    return tested.get(step)!;
  };
  const checkOf = (pack: string, id: string) => plan.human.find((step) => step.pack === pack && step.id === id);
  const ready: CatalogEntry[] = [];
  for (const entry of plan.catalog ?? []) if (!entry.after || (await passes(checkOf(entry.pack, entry.after)))) ready.push(entry);
  const issued = issue ? await issue(ready) : [];
  if (repair) for (const step of plan.human) if (step.repair) await passes(step);
  const jobs: Plan["jobs"] = [];
  const dropped: Plan["dropped"] = [];
  for (const job of plan.jobs) {
    if (!job.after || (await passes(plan.human.find((step) => step.pack === job.pack && step.id === job.after)))) jobs.push(job);
    else dropped.push({ pack: job.pack, item: `job ${job.id}`, reason: `check ${job.after} does not pass`, check: job.after });
  }
  const config: Plan["config"] = [];
  for (const entry of plan.config) {
    if (!entry.after || (await passes(plan.human.find((step) => step.pack === entry.pack && step.id === entry.after)))) config.push(entry);
    else dropped.push({ pack: entry.pack, item: `config ${entry.provider}:${entry.key}`, reason: `check ${entry.after} does not pass`, check: entry.after });
  }
  const failed = [...tested].filter(([, passed]) => !passed).map(([step]) => step);
  return { plan: { ...plan, jobs, config, dropped: [...plan.dropped, ...dropped] }, failed, issued };
}

/** Whether a pack step still waits for its human step. Each human step is probed once, when its first waiting step comes up, so earlier steps can install what the probe runs. */
function waiter(plan: Plan, run: Runner) {
  const passed = new Map<string, boolean>();
  return async (step: Plan["steps"][number]) => {
    if (!step.after) return false;
    const key = `${step.pack}:${step.after}`;
    if (!passed.has(key)) {
      const human = plan.human.find((item) => item.pack === step.pack && item.id === step.after);
      passed.set(key, human ? (await run(human.probe)) === 0 : false);
    }
    return !passed.get(key);
  };
}

/** The sources whose packs or skills this plan lacks because they could not be fetched. */
function unreachable(plan: Plan) {
  const packs = plan.packs.filter((pack) => !pack.available && pack.reason?.startsWith("not found; unreachable")).map((pack) => `the ${pack.name} pack`);
  const skills = plan.dropped.filter((item) => item.reason === "its source is unreachable").map((item) => `${item.item} of ${item.pack}`);
  return [...packs, ...skills];
}

function packFindings(plan: Plan): Finding[] {
  return plan.packs
    .filter((pack) => !pack.available || pack.reason)
    .map((pack) => ({ id: `pack:${pack.name}`, pack: pack.name, say: pack.available ? `The ${pack.name} pack uses its last fetched files: ${pack.reason}` : `The ${pack.name} pack is not applied: ${pack.reason}` }));
}

function hubFindings(plan: Plan): Finding[] {
  const left = plan.dropped.filter((item) => item.reason === hublessReason).length;
  if (!left) return [];
  const items = left === 1 ? "1 item that runs" : `${left} items that run`;
  return [{ id: "hubless", pack: "engine", say: `Your profile lists devboxes but names no hub, so this machine leaves out ${items} on the hub. Run fleet hub here on the machine that should be the hub.` }];
}

function viaEngine(plan: Plan, run: Runner): Runner {
  return (command) => run(engineCommand(command, plan.engineRoot));
}

/** Runs commands with the plan's home directory as HOME, so a step installs into the home it applies to, and with the plan's profile, so a nested fleet reads the profile this run applies or checks. */
function spawnRunner(home: string, profileDir: string | undefined): Runner {
  return async (command) => {
    try {
      return await Bun.spawn(command, { stdout: "ignore", stderr: "ignore", env: { ...Bun.env, HOME: home, ...(profileDir ? { FLEET_PROFILE_DIR: profileDir } : {}) } }).exited;
    } catch {
      return 127;
    }
  };
}
