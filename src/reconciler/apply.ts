import { install, plan as planFiles } from "../files/install.ts";
import { cannotTell } from "../pack/types.ts";
import type { Action, CatalogEntry, Finding, HumanStep, Owned, PackCheck, Plan, Report } from "../pack/types.ts";
import { engineCommand } from "./engine-command.ts";
import { changeLedger, ledgerKey, readLedger, undoVariable, type LedgerStep } from "./ledger.ts";
import { hublessReason } from "./resolve.ts";

export type AdapterContext = { home: string; dryRun: boolean; adopt: string[] };
export type AdapterResult = { actions: Action[]; findings: Finding[] };
export type Adapter = {
  name: "files" | "config" | "jobs" | "identity" | "t3";
  /** The targets that --adopt may name for this adapter. */
  targets(plan: Plan): string[];
  apply(plan: Plan, context: AdapterContext): Promise<AdapterResult>;
};
export type Runner = (command: string[], env?: Record<string, string>) => Promise<number>;
/** Fills this machine's credential for each served service: the hub issues its own, and a node pulls its own from the hub. Reports what failed. */
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
  const node = plan.onHub || plan.reachesHub ? plan.machine.name : undefined;
  const issue = !context.dryRun && node && options.issue ? (ready: CatalogEntry[]) => options.issue!(ready, node) : undefined;
  const gated = await gate(plan, run, !context.dryRun, issue);
  report.findings.push(...gated.issued, ...gated.failed.map((step) => humanFinding(step, context.dryRun)), ...gated.failedChecks.map(checkFinding));
  for (const adapter of adapters) {
    const result = await adapter.apply(gated.plan, context);
    report.actions.push(...result.actions);
    report.findings.push(...result.findings);
  }
  const before = await readLedger(options.home);
  const record = async (key: string, step?: LedgerStep) => {
    if (!context.dryRun) await changeLedger(options.home, key, step);
  };
  const failed = new Set<string>();
  const undo = async (items: UndoItem[]) => {
    for (const { step, cause } of items) {
      if (failed.has(step.pack)) continue;
      const undoing = undoRunner(run, step);
      const holds = await undoHeld(step, undoing);
      if (holds === "no") {
        await record(ledgerKey(step));
        continue;
      }
      if (holds !== "yes") {
        report.findings.push(undoFinding(step, cause, holds));
        if (holds === "unknown" && step.pack === "base") report.ok = false;
        continue;
      }
      const target = `step ${step.pack}/${step.id}`;
      if (context.dryRun) {
        report.actions.push({ target, operation: "remove", reason: `fleet apply would undo it: ${because(step, cause)}` });
        continue;
      }
      if ((await undoing(step.undo)) === 0 && !heldCodes.includes(await undoing(step.check))) {
        await record(ledgerKey(step));
        report.actions.push({ target, operation: "remove", reason: because(step, cause) });
        continue;
      }
      report.findings.push({ id: `undo:${step.id}`, pack: step.pack, say: `Fleet could not undo step ${step.id} of the ${step.pack} pack, ${whose(cause)}. The next fleet apply tries again.`, repair: "apply" });
      if (step.pack === "base") report.ok = false;
    }
  };
  const items = undoItems(plan, before);
  await undo(items.filter((item) => item.cause === "pack"));
  const waits = waiter(plan, run);
  const held = async (step: Plan["steps"][number]) => {
    if (step.undo && step.check) await record(ledgerKey(step), ledgerStep(plan, step));
  };
  const passes = async (step: Plan["steps"][number]) => step.check !== undefined && (await run(step.check)) === 0;
  for (const step of context.dryRun ? [] : plan.steps) {
    if (failed.has(step.pack) || (await waits(step))) continue;
    if (await passes(step)) {
      await held(step);
      continue;
    }
    const ran = (await run(step.run)) === 0;
    const holds = await passes(step);
    if (holds) await held(step);
    if (ran && (holds || !step.check)) continue;
    failed.add(step.pack);
    report.findings.push({ id: `step:${step.id}`, pack: step.pack, say: ran ? `Step ${step.id} of the ${step.pack} pack ran, but does not pass its check.` : `Step ${step.id} of the ${step.pack} pack failed.`, repair: "apply" });
    if (step.pack === "base") report.ok = false;
  }
  await undo(items.filter((item) => item.cause !== "pack"));
  return report;
}

export async function check(plan: Plan, options: { home: string; adapters?: Adapter[]; run?: Runner }): Promise<Report> {
  const run = viaEngine(plan, options.run ?? spawnRunner(options.home, plan.machine.profileDir));
  const report = await apply(plan, { ...options, dryRun: true });
  for (const item of plan.checks) {
    if (report.findings.some((finding) => finding.id === `check:${item.id}` && finding.pack === item.pack)) continue;
    if ((await run(item.run)) !== 0) report.findings.push(checkFinding(item));
  }
  const waits = waiter(plan, run);
  for (const step of plan.steps) {
    if (await waits(step)) continue;
    if (step.check && (await run(step.check)) !== 0) report.findings.push({ id: `step:${step.id}`, pack: step.pack, say: `Step ${step.id} of the ${step.pack} pack does not pass its check.`, repair: "apply" });
  }
  for (const { step, cause } of undoItems(plan, await readLedger(options.home))) {
    if (report.actions.some((action) => action.target === `step ${step.pack}/${step.id}`)) report.findings.push({ id: `undo:${step.id}`, pack: step.pack, say: `${stillHolds(step, cause)} Run fleet apply to undo it.`, repair: "apply" });
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

const checkFinding = (item: Owned<PackCheck>): Finding => ({ id: `check:${item.id}`, pack: item.pack, say: item.say, repair: "apply" });

function humanFinding(step: Owned<HumanStep>, repairStillToRun: boolean): Finding {
  return { id: `human:${step.id}`, pack: step.pack, say: step.command ? `${step.say} Run: ${step.command}` : step.say, repair: repairStillToRun && step.repair && !step.command ? "apply" : "human" };
}

/** Tests each check once, running a Fleet repair first when a human step's probe fails and repairs are on, then drops the items whose check fails. A config entry may also wait for a pack check, which has no repair. It tests the checks that served services wait for first, which only the hub can, and fills their credentials, so a repair that reads a credential sees it in the same apply. */
async function gate(plan: Plan, run: Runner, repair: boolean, issue?: (ready: CatalogEntry[]) => Promise<Finding[]>): Promise<{ plan: Plan; failed: Array<Owned<HumanStep>>; failedChecks: Array<Owned<PackCheck>>; issued: Finding[] }> {
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
  for (const entry of plan.catalog ?? []) if (!entry.after || plan.reachesHub || (await passes(checkOf(entry.pack, entry.after)))) ready.push(entry);
  const issued = issue ? await issue(ready) : [];
  if (repair) for (const step of plan.human) if (step.repair) await passes(step);
  const jobs: Plan["jobs"] = [];
  const dropped: Plan["dropped"] = [];
  for (const job of plan.jobs) {
    if (!job.after || (await passes(plan.human.find((step) => step.pack === job.pack && step.id === job.after)))) jobs.push(job);
    else dropped.push({ pack: job.pack, item: `job ${job.id}`, reason: `check ${job.after} does not pass`, check: job.after });
  }
  const checked = new Map<Owned<PackCheck>, boolean>();
  const checkPasses = async (item: Owned<PackCheck>) => {
    if (!checked.has(item)) checked.set(item, (await run(item.run)) === 0);
    return checked.get(item)!;
  };
  const waitsFor = (pack: string, id: string) => {
    const human = checkOf(pack, id);
    const check = human ? undefined : plan.checks.find((item) => item.pack === pack && item.id === id);
    return check ? checkPasses(check) : passes(human);
  };
  const config: Plan["config"] = [];
  for (const entry of plan.config) {
    if (!entry.after || (await waitsFor(entry.pack, entry.after))) config.push(entry);
    else dropped.push({ pack: entry.pack, item: `config ${entry.provider}:${entry.key}`, reason: `check ${entry.after} does not pass`, check: entry.after, value: entry.value });
  }
  const failed = [...tested].filter(([, passed]) => !passed).map(([step]) => step);
  const failedChecks = [...checked].filter(([, passed]) => !passed).map(([item]) => item);
  return { plan: { ...plan, jobs, config, dropped: [...plan.dropped, ...dropped] }, failed, failedChecks, issued };
}

type Cause = { workflow: string } | "pack" | "plan";
type UndoItem = { step: LedgerStep; cause: Cause };
type Held = "yes" | "no" | "waits" | "unsure" | "unknown";

const heldCodes = [0, cannotTell];

function ledgerStep(plan: Plan, step: Plan["steps"][number]): LedgerStep {
  const prerequisite = step.after ? plan.human.find((human) => human.pack === step.pack && human.id === step.after)?.probe : undefined;
  return { pack: step.pack, id: step.id, check: step.left ?? step.check!, undo: step.undo!, ...(step.after ? { after: step.after } : {}), ...(prerequisite ? { prerequisite } : {}) };
}

/** The steps to undo: those whose workflow is off while their pack is on, and those the ledger holds that left the plan, except in a pack the profile lists but cannot load. A step the ledger holds is undone with the commands it had when it last held. */
function undoItems(plan: Plan, ledger: LedgerStep[]): UndoItem[] {
  const recorded = new Map(ledger.map((step) => [ledgerKey(step), step]));
  const fromPlan = (plan.undo ?? []).map((step) => ({ step: recorded.get(ledgerKey(step)) ?? { ...ledgerStep(plan, step), ...(step.prerequisite ? { prerequisite: step.prerequisite } : {}) }, cause: { workflow: step.workflow! } }));
  const planned = new Set([...plan.steps, ...(plan.undo ?? [])].map(ledgerKey));
  const listed = new Set(plan.packs.map((pack) => pack.name));
  const unloaded = new Set(plan.packs.filter((pack) => !pack.available).map((pack) => pack.name));
  const fromLedger = ledger.filter((step) => !planned.has(ledgerKey(step)) && !unloaded.has(step.pack)).map((step) => ({ step, cause: listed.has(step.pack) ? ("plan" as const) : ("pack" as const) }));
  return [...fromPlan, ...fromLedger];
}

const because = (step: LedgerStep, cause: Cause) => (cause === "pack" ? `the ${step.pack} pack is off` : cause === "plan" ? "this machine no longer plans it" : `workflow ${cause.workflow} is off`);
const whose = (cause: Cause) => (cause === "pack" ? "which is off" : cause === "plan" ? "now that this machine no longer plans it" : `whose workflow ${cause.workflow} is off`);
const though = (cause: Cause) => (cause === "pack" ? "the pack is off" : cause === "plan" ? "this machine no longer plans it" : `its workflow ${cause.workflow} is off`);

function stillHolds(step: LedgerStep, cause: Cause) {
  const what = `step ${step.id} of the ${step.pack} pack`;
  if (cause === "pack") return `The ${step.pack} pack is off, but ${what} still holds what it set.`;
  if (cause === "plan") return `This machine no longer plans ${what}, but it still holds what it set.`;
  return `The workflow ${cause.workflow} is off, but ${what} still holds what it set.`;
}

async function undoHeld(step: LedgerStep, run: Runner): Promise<Held> {
  const code = await run(step.check);
  if (!heldCodes.includes(code)) return "no";
  const waits = step.after !== undefined && !(step.prerequisite && (await run(step.prerequisite)) === 0);
  if (code === 0) return waits ? "waits" : "yes";
  return waits ? "unsure" : "unknown";
}

function undoFinding(step: LedgerStep, cause: Cause, held: Exclude<Held, "yes" | "no">): Finding {
  const id = `undo:${step.id}`;
  if (held === "unknown") return { id, pack: step.pack, say: `Fleet cannot tell whether step ${step.id} of the ${step.pack} pack still holds what it set, though ${though(cause)}.`, repair: "apply" };
  const say = `Step ${step.id} of the ${step.pack} pack waits for ${step.after} before Fleet can undo it.`;
  return held === "waits" ? { id, pack: step.pack, say, repair: "human" } : { id, pack: step.pack, say };
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
  return (command, env) => run(engineCommand(command, plan.engineRoot), env);
}

/** Names the step in FLEET_UNDO, so a nested fleet runs the command of a pack that is off, but only for this step's undo, check and prerequisite. */
const undoRunner = (run: Runner, step: LedgerStep): Runner => (command) => run(command, { [undoVariable]: ledgerKey(step) });

/** Runs commands with the plan's home directory as HOME, so a step installs into the home it applies to, and with the plan's profile, so a nested fleet reads the profile this run applies or checks. */
function spawnRunner(home: string, profileDir: string | undefined): Runner {
  return async (command, env = {}) => {
    try {
      return await Bun.spawn(command, { stdout: "ignore", stderr: "ignore", env: { ...Bun.env, HOME: home, ...(profileDir ? { FLEET_PROFILE_DIR: profileDir } : {}), ...env } }).exited;
    } catch {
      return 127;
    }
  };
}
