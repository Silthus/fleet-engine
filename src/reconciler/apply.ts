import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { inside, install, plan as planFiles } from "../files/install.ts";
import type { Action, DesiredFile, Finding, Plan, Report } from "../pack/types.ts";

export type AdapterContext = { home: string; dryRun: boolean; adopt: string[] };
export type AdapterResult = { actions: Action[]; findings: Finding[] };
export type Adapter = { name: "files" | "config" | "jobs" | "identity" | "t3"; apply(plan: Plan, context: AdapterContext): Promise<AdapterResult> };
export type Runner = (command: string[]) => Promise<number>;

export const filesGroup = "fleet";

export const filesAdapter: Adapter = {
  name: "files",
  async apply(plan, { home, dryRun, adopt }) {
    const outage = unreachablePacks(plan).length > 0;
    const firstPreview = await planFiles(home, plan.files, filesGroup, adopt);
    const parked = outage ? await Promise.all(firstPreview.filter((action) => action.operation === "remove").map((action) => current(home, action.target))) : [];
    const files = [...plan.files, ...parked];
    const preview = parked.length ? await planFiles(home, files, filesGroup, adopt) : firstPreview;
    const kept = preview.filter((action) => action.operation === "conflict");
    const skip = kept.map((action) => action.target);
    const findings: Finding[] = kept.map((action) => ({
      id: `kept:${action.target}`,
      pack: "engine",
      say: `Kept your ${action.target} (${action.reason}). Run fleet apply --adopt ${action.target} to take Fleet's version.`,
    }));
    if (dryRun) {
      for (const action of preview.filter((item) => ["create", "replace", "remove"].includes(item.operation) && !skip.includes(item.target))) {
        findings.push({ id: `files:${action.target}`, pack: "engine", say: `${action.target} needs to ${action.operation === "create" ? "be created" : action.operation === "replace" ? "be updated" : "be removed"}.`, repair: "apply" });
      }
      return { actions: preview, findings };
    }
    const { actions } = await install(home, files, filesGroup, adopt, skip);
    return { actions: [...actions, ...kept], findings };
  },
};

export async function apply(plan: Plan, options: { home: string; dryRun?: boolean; adopt?: string[]; adapters?: Adapter[]; run?: Runner }): Promise<Report> {
  const context = { home: options.home, dryRun: options.dryRun ?? false, adopt: options.adopt ?? [] };
  const report: Report = { ok: true, actions: [], findings: [], humanLeft: [] };
  report.findings.push(...packFindings(plan));
  if (plan.unanswered.length) {
    report.ok = false;
    report.findings.push(...plan.unanswered.map((setting) => ({ id: `unanswered:${setting.key}`, pack: setting.key.split(".")[0] ?? "", say: `${setting.question} Answer it with fleet set ${setting.key}=<value>.`, repair: "human" as const })));
    return report;
  }
  for (const adapter of options.adapters ?? [filesAdapter]) {
    const result = await adapter.apply(plan, context);
    report.actions.push(...result.actions);
    report.findings.push(...result.findings);
  }
  if (context.dryRun) return report;
  const run = options.run ?? spawnRunner;
  const failed = new Set<string>();
  for (const step of plan.steps) {
    if (failed.has(step.pack)) continue;
    if ((await run(step.run)) === 0) continue;
    failed.add(step.pack);
    report.findings.push({ id: `step:${step.id}`, pack: step.pack, say: `Step ${step.id} of the ${step.pack} pack failed.`, repair: "apply" });
    if (step.pack === "base") report.ok = false;
  }
  return report;
}

export async function check(plan: Plan, options: { home: string; adapters?: Adapter[]; run?: Runner }): Promise<Report> {
  const run = options.run ?? spawnRunner;
  const report = await apply(plan, { ...options, dryRun: true });
  for (const item of plan.checks) {
    if ((await run(item.run)) !== 0) report.findings.push({ id: `check:${item.id}`, pack: item.pack, say: item.say, repair: "apply" });
  }
  for (const step of plan.human) {
    if ((await run(step.probe)) === 0) continue;
    report.humanLeft.push(step);
    report.findings.push({ id: `human:${step.id}`, pack: step.pack, say: step.command ? `${step.say} Run: ${step.command}` : step.say, repair: "human" });
  }
  if (report.findings.some((finding) => finding.repair)) report.ok = false;
  return report;
}

async function current(home: string, target: string): Promise<DesiredFile> {
  const path = inside(home, target);
  if ((await lstat(path)).isSymbolicLink()) return { target, source: resolve(dirname(path), await readlink(path)) };
  return { target, content: await readFile(path, "utf8") };
}

function unreachablePacks(plan: Plan) {
  return plan.packs.filter((pack) => !pack.available && pack.reason?.startsWith("not found; unreachable"));
}

function packFindings(plan: Plan): Finding[] {
  return plan.packs
    .filter((pack) => !pack.available || pack.reason)
    .map((pack) => ({ id: `pack:${pack.name}`, pack: pack.name, say: pack.available ? `The ${pack.name} pack uses its last fetched files: ${pack.reason}` : `The ${pack.name} pack is not applied: ${pack.reason}` }));
}

async function spawnRunner(command: string[]) {
  try {
    return await Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    return 127;
  }
}
