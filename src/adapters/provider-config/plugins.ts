import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inside } from "../../files/install.ts";
import type { Finding, Plan } from "../../pack/types.ts";
import type { CommandRunner } from "./adapter.ts";

export const pluginsTarget = ".config/fleet/plugins.json";
const pluginId = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9._-]*$/;

type Owned = { claude: string[] };

export function wantedPlugins(plan: Plan) {
  return plan.config.flatMap((entry) => {
    const [root, id, ...rest] = entry.key.split(".");
    if (entry.provider !== "claude" || root !== "enabledPlugins" || !id || rest.length || entry.value !== true) return [];
    if (!pluginId.test(id)) throw new Error(`${entry.pack} enables an invalid Claude plugin id: ${id}`);
    return [id];
  });
}

export async function reconcilePlugins(plan: Plan, home: string, dryRun: boolean, run: CommandRunner): Promise<Finding[]> {
  const wanted = wantedPlugins(plan);
  const owned = await readOwned(home);
  if (!wanted.length && !owned.claude.length) return [];
  const installed = await listInstalled(run);
  if (!installed) {
    return wanted.length ? [{ id: "plugins:claude", pack: "engine", say: `Claude Code is not installed yet, so its plugins wait: ${wanted.join(", ")}.`, repair: "apply" }] : [];
  }
  const missing = wanted.filter((id) => !installed.includes(id));
  const departed = owned.claude.filter((id) => !wanted.includes(id) && installed.includes(id));
  if (dryRun) {
    return [
      ...missing.map((id) => ({ id: `plugin:${id}`, pack: "engine", say: `The Claude plugin ${id} needs to be installed.`, repair: "apply" as const })),
      ...departed.map((id) => ({ id: `plugin:${id}`, pack: "engine", say: `The Claude plugin ${id} needs to be removed.`, repair: "apply" as const })),
    ];
  }
  const findings: Finding[] = [];
  const next = new Set(owned.claude.filter((id) => installed.includes(id)));
  for (const id of missing) {
    next.add(id);
    await writeOwned(home, { claude: [...next] });
    if ((await run(["claude", "plugin", "install", id, "--scope", "user"])).code === 0) continue;
    findings.push({ id: `plugin:${id}`, pack: "engine", say: `Could not install the Claude plugin ${id}.`, repair: "apply" });
  }
  for (const id of departed) {
    if ((await run(["claude", "plugin", "uninstall", id, "--scope", "user", "--keep-data"])).code === 0) next.delete(id);
    else findings.push({ id: `plugin:${id}`, pack: "engine", say: `Could not remove the Claude plugin ${id}.`, repair: "apply" });
  }
  if (!sameList([...next], owned.claude)) await writeOwned(home, { claude: [...next] });
  return findings;
}

async function listInstalled(run: CommandRunner): Promise<string[] | undefined> {
  const result = await run(["claude", "plugin", "list", "--json"]);
  if (result.code !== 0) return undefined;
  const entries = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(entries)) throw new Error("Claude Code printed an unknown plugin list format");
  return entries.flatMap((entry) => (entry && typeof entry.id === "string" && entry.scope === "user" ? [entry.id as string] : []));
}

async function readOwned(home: string): Promise<Owned> {
  try {
    const value = JSON.parse(await readFile(inside(home, pluginsTarget), "utf8")) as Owned;
    if (!Array.isArray(value.claude) || value.claude.some((id) => typeof id !== "string")) throw new Error(`${pluginsTarget} is not a plugin record`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { claude: [] };
    throw error;
  }
}

async function writeOwned(home: string, owned: Owned) {
  const path = inside(home, pluginsTarget);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, `${JSON.stringify(owned, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

const sameList = (left: string[], right: string[]) => left.length === right.length && left.every((id) => right.includes(id));
