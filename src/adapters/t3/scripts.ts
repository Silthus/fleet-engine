import { resolve } from "node:path";
import type { Finding, Owned, Plan, T3ProjectScript } from "../../pack/types.ts";
import type { AdapterResult } from "../../reconciler/apply.ts";
import { settingProject } from "../../reconciler/resolve.ts";
import { engineShellCommand } from "../../reconciler/engine-command.ts";
import { sourceOutage } from "../provider-config/adapter.ts";
import { same } from "../provider-config/fields.ts";
import type { T3Rpc } from "./port.ts";
import { readT3Settings } from "./settings.ts";
import { activeProjects, expandHome, realPath, type ShellProject } from "./tasks.ts";

type Script = { id: string; name: string; command: string; icon: string; runOnWorktreeCreate: boolean; async?: boolean };
type Entry = Record<string, unknown> & { defaultProjectScripts?: Script[] };
type Project = ShellProject & { scripts?: Script[] };
type Settings = { defaultProjectScripts?: Script[]; projectScriptOverrides?: Record<string, Script[] | null>; projectSettingsOverrides?: Record<string, Entry>; projectSettingsFolded?: boolean };

const prefix = "fleet-";
const scriptId = (script: Owned<T3ProjectScript>) => `${prefix}${script.pack}-${script.id}`;
const isFleet = (script: Script) => script.id.startsWith(prefix);
const finding = (id: string, say: string, repair: Finding["repair"]): Finding => ({ id: `t3:${id}`, pack: "engine", say, repair });

export const plannedScripts = (plan: Plan) => plan.t3ProjectScripts ?? [];

/** A setting a script names that holds no usable path: the script skips it, and fleet set can fix it. */
export function settingProblems(plan: Plan): Finding[] {
  return plannedScripts(plan).flatMap((script) => {
    const value = script.projectSetting === undefined ? undefined : plan.settings[script.projectSetting];
    if (value === undefined || settingProject(script, plan.settings) !== undefined) return [];
    return [finding(`script-setting:${scriptId(script)}`, `The setting ${script.projectSetting} is ${JSON.stringify(value)}, not an absolute path or a path under ~/, so the worktree script ${scriptId(script)} skips it. Fix it with fleet set ${script.projectSetting}=<path>.`, "human")];
  });
}

export function waitingScripts(plan: Plan): Finding[] {
  const ids = plannedScripts(plan).map(scriptId);
  if (!ids.length) return [];
  return [finding("scripts", `T3 Code is not running, so the worktree ${ids.length === 1 ? `script ${ids[0]} waits` : `scripts ${ids.join(", ")} wait`}. The next fleet apply after T3 Code starts adds ${ids.length === 1 ? "it" : "them"}.`, "apply")];
}

/** The scripts T3 Code runs for a project: its own override, then the defaults, then, before T3 folded its old fields, the old per-project ones. */
function effectiveScripts(settings: Settings, project: Project): Script[] {
  const override = settings.projectSettingsOverrides?.[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  const defaults = settings.defaultProjectScripts ?? [];
  if (settings.projectSettingsFolded) return defaults;
  const legacy = settings.projectScriptOverrides?.[project.id];
  if (legacy === null) return defaults;
  return legacy ?? (project.scripts?.length ? project.scripts : defaults);
}

function matches(pattern: string, root: string, home: string) {
  if (!pattern.includes("*")) return realPath(expandHome(home, pattern)) === realPath(root);
  const parts = resolve(expandHome(home, pattern)).split("/").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"));
  return new RegExp(`^${parts.join("/")}$`).test(resolve(root));
}

/** T3 Code runs only the first script marked runOnWorktreeCreate, so Fleet's scripts go first and the first one also runs the rest, the project's own setup script last. Each command runs in its own subshell, so one that ends in ; or & still chains. */
function desired(current: Script[], wanted: Array<Owned<T3ProjectScript>>, engineRoot: string | undefined): Script[] {
  const own = current.filter((script) => !isFleet(script));
  if (!wanted.length) return own;
  const commands = wanted.map((script) => engineShellCommand(script.command, engineRoot));
  const setup = own.find((script) => script.runOnWorktreeCreate);
  const parts = [...commands, ...(setup ? [setup.command] : [])];
  const chain = parts.length === 1 ? parts[0]! : parts.map((command) => `(\n${command}\n)`).join(" && ");
  const fleet = wanted.map((script, index) => ({ id: scriptId(script), name: script.name, icon: "configure", command: index === 0 ? chain : commands[index]!, runOnWorktreeCreate: index === 0, async: false }));
  return [...fleet, ...own];
}

function change(before: Script[], after: Script[]) {
  const ids = (list: Script[]) => new Set(list.filter(isFleet).map((script) => script.id));
  const [old, next] = [ids(before), ids(after)];
  const added = [...next].filter((id) => !old.has(id));
  const removed = [...old].filter((id) => !next.has(id));
  return [added.length ? `add script ${added.join(", ")}` : "", removed.length ? `remove script ${removed.join(", ")}` : "", !added.length && !removed.length ? "update Fleet's scripts" : ""].filter(Boolean).join("; ");
}

/** Puts each pack's worktree scripts on the T3 projects they match, and takes Fleet's scripts off every other project. While a pack source is out, a project that would lose a Fleet script stays as it is. T3 Code derives projectScriptOverrides from projectSettingsOverrides, so what a project inherits leaves out both. */
export async function reconcileScripts(rpc: T3Rpc, plan: Plan, home: string, dryRun: boolean, result: AdapterResult) {
  const wanted = plannedScripts(plan);
  const outage = sourceOutage(plan);
  const settings = (await readT3Settings(rpc)) as Settings;
  const projects = (await activeProjects(rpc)) as Project[];
  const changes: Array<{ project: Project; before: Script[]; after: Script[]; entry: Entry }> = [];
  for (const project of projects) {
    const before = effectiveScripts(settings, project);
    const mine = wanted.filter((script) => script.projects.some((pattern) => matches(pattern, project.workspaceRoot, home)));
    const after = desired(before, mine, plan.engineRoot);
    if (same(before, after)) continue;
    if (outage && before.some((script) => isFleet(script) && !after.some((item) => item.id === script.id))) continue;
    const { defaultProjectScripts: _, ...rest } = settings.projectSettingsOverrides?.[project.id] ?? {};
    const { [project.id]: _derived, ...legacy } = settings.projectScriptOverrides ?? {};
    const inherited = effectiveScripts({ ...settings, projectSettingsOverrides: { ...settings.projectSettingsOverrides, [project.id]: rest }, projectScriptOverrides: legacy }, project);
    changes.push({ project, before, after, entry: same(after, inherited) ? rest : { ...rest, defaultProjectScripts: after } });
  }
  if (!changes.length) return;
  if (settings.projectSettingsOverrides === undefined) {
    const ids = wanted.map(scriptId);
    return void result.findings.push(finding("scripts", `This T3 Code keeps no project settings, so Fleet cannot add the worktree ${ids.length === 1 ? "script" : "scripts"} ${ids.join(", ")}. Update T3 Code, then run fleet apply.`, "human"));
  }
  if (dryRun) {
    for (const { project, after } of changes) {
      const ids = after.filter(isFleet).map((script) => script.id);
      result.findings.push(finding(`script:${project.workspaceRoot}`, ids.length ? `T3 Code needs the worktree ${ids.length === 1 ? "script" : "scripts"} ${ids.join(", ")} on ${project.workspaceRoot}.` : `T3 Code still has Fleet's worktree scripts on ${project.workspaceRoot}.`, "apply"));
    }
    return;
  }
  await rpc.call("server.updateSettings", { patch: { projectSettingsOverrides: Object.fromEntries(changes.map(({ project, entry }) => [project.id, entry])) } });
  const now = (await readT3Settings(rpc)) as Settings;
  for (const { project, before, after } of changes) {
    if (same(effectiveScripts(now, project), after)) result.actions.push({ target: `t3 project ${project.workspaceRoot}`, operation: "replace", reason: change(before, after) });
    else result.findings.push(finding(`script:${project.workspaceRoot}`, `T3 Code did not take the worktree scripts for ${project.workspaceRoot}. Run fleet apply again.`, "apply"));
  }
}
