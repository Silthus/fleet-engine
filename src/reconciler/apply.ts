import { install, plan as planFiles } from "../files/install.ts";
import type { Action, Finding, Plan, Report } from "../pack/types.ts";

export type AdapterContext = { home: string; dryRun: boolean; adopt: string[] };
export type AdapterResult = { actions: Action[]; findings: Finding[] };
export type Adapter = {
  name: "files" | "config" | "jobs" | "identity" | "t3";
  /** The targets that --adopt may name for this adapter. */
  targets(plan: Plan): string[];
  apply(plan: Plan, context: AdapterContext): Promise<AdapterResult>;
};
export type Runner = (command: string[]) => Promise<number>;

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

export async function apply(plan: Plan, options: { home: string; dryRun?: boolean; adopt?: string[]; adapters?: Adapter[]; run?: Runner }): Promise<Report> {
  const context = { home: options.home, dryRun: options.dryRun ?? false, adopt: options.adopt ?? [] };
  const adapters = options.adapters ?? [filesAdapter];
  const adoptable = new Set(adapters.flatMap((adapter) => adapter.targets(plan)));
  const unknown = context.adopt.filter((target) => !adoptable.has(target));
  if (unknown.length) throw new Error(`nothing to adopt at ${unknown.join(", ")}: no part of your profile writes it`);
  const report: Report = { ok: true, actions: [], findings: [], humanLeft: [] };
  report.findings.push(...packFindings(plan));
  if (plan.unanswered.length) {
    report.ok = false;
    report.findings.push(...plan.unanswered.map((setting) => ({ id: `unanswered:${setting.key}`, pack: setting.key.split(".")[0] ?? "", say: `${setting.question} Answer it with fleet set ${setting.key}=<value>.`, repair: "human" as const })));
    return report;
  }
  for (const adapter of adapters) {
    const result = await adapter.apply(plan, context);
    report.actions.push(...result.actions);
    report.findings.push(...result.findings);
  }
  if (context.dryRun) return report;
  const run = options.run ?? spawnRunner(options.home);
  const failed = new Set<string>();
  const waiting = await waitingSteps(plan, run);
  for (const step of plan.steps) {
    if (failed.has(step.pack) || waiting.has(step)) continue;
    if (step.check && (await run(step.check)) === 0) continue;
    if ((await run(step.run)) === 0) continue;
    failed.add(step.pack);
    report.findings.push({ id: `step:${step.id}`, pack: step.pack, say: `Step ${step.id} of the ${step.pack} pack failed.`, repair: "apply" });
    if (step.pack === "base") report.ok = false;
  }
  return report;
}

export async function check(plan: Plan, options: { home: string; adapters?: Adapter[]; run?: Runner }): Promise<Report> {
  const run = options.run ?? spawnRunner(options.home);
  const report = await apply(plan, { ...options, dryRun: true });
  for (const item of plan.checks) {
    if ((await run(item.run)) !== 0) report.findings.push({ id: `check:${item.id}`, pack: item.pack, say: item.say, repair: "apply" });
  }
  const waiting = await waitingSteps(plan, run);
  for (const step of plan.steps) {
    if (waiting.has(step)) continue;
    if (step.check && (await run(step.check)) !== 0) report.findings.push({ id: `step:${step.id}`, pack: step.pack, say: `Step ${step.id} of the ${step.pack} pack does not pass its check.`, repair: "apply" });
  }
  for (const step of plan.human) {
    if ((await run(step.probe)) === 0) continue;
    report.humanLeft.push(step);
    report.findings.push({ id: `human:${step.id}`, pack: step.pack, say: step.command ? `${step.say} Run: ${step.command}` : step.say, repair: "human" });
  }
  if (report.findings.some((finding) => finding.repair || finding.id.startsWith("kept:"))) report.ok = false;
  return report;
}

/** Pack steps whose human step has not passed yet: they wait for the person instead of failing. */
async function waitingSteps(plan: Plan, run: Runner) {
  const passed = new Map<string, boolean>();
  const waiting = new Set<Plan["steps"][number]>();
  for (const step of plan.steps) {
    if (!step.after) continue;
    const human = plan.human.find((item) => item.pack === step.pack && item.id === step.after);
    const key = `${step.pack}:${step.after}`;
    if (!passed.has(key)) passed.set(key, human ? (await run(human.probe)) === 0 : false);
    if (!passed.get(key)) waiting.add(step);
  }
  return waiting;
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

/** Runs commands with the plan's home directory as HOME, so a step installs into the home it applies to. */
function spawnRunner(home: string): Runner {
  return async (command) => {
    try {
      return await Bun.spawn(command, { stdout: "ignore", stderr: "ignore", env: { ...Bun.env, HOME: home } }).exited;
    } catch {
      return 127;
    }
  };
}
