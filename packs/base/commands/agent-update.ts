import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Run = (command: string[]) => Promise<{ code: number; out: string }>;

export const codexInstaller = join(import.meta.dir, "../lib/install-codex.sh");

const updates: Array<{ name: string; installed: string[]; marker: string; update: string[] }> = [
  { name: "Claude Code", installed: ["sh", "-c", 'test -x "$HOME/.local/bin/claude" && echo native'], marker: "native", update: ["claude", "update"] },
  { name: "Codex", installed: ["sh", "-c", 'readlink "$HOME/.local/bin/codex"'], marker: "/.local/share/fleet/codex/", update: ["sh", codexInstaller] },
  { name: "Codex from Bun", installed: ["bun", "pm", "ls", "-g"], marker: "@openai/codex", update: ["bun", "add", "-g", "@openai/codex@latest"] },
];

/** Updates each agent CLI that Fleet installed and skips the others. Returns the lines to print and whether every update worked. */
export async function updateAgents(run: Run): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  for (const agent of updates) {
    const found = await run(agent.installed);
    if (found.code !== 0 || !found.out.includes(agent.marker)) {
      lines.push(`${agent.name}: not installed by Fleet, skipped.`);
      continue;
    }
    const result = await run(agent.update);
    ok &&= result.code === 0;
    lines.push(`${agent.name}: ${result.code === 0 ? "up to date" : `update failed (exit ${result.code})`}.`);
  }
  return { ok, lines };
}

const pluginId = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function updatePlugins(run: Run): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const marketplaces = await run(["claude", "plugin", "marketplace", "update"]);
  if (marketplaces.code === 127) lines.push("Claude Code plugins: claude is not installed, skipped.");
  else {
    const failed: string[] = marketplaces.code === 0 ? [] : ["the marketplaces"];
    const ids = userPlugins((await run(["claude", "plugin", "list", "--json"])).out);
    for (const id of ids ?? []) if ((await run(["claude", "plugin", "update", id, "--scope", "user"])).code !== 0) failed.push(id);
    ok &&= ids !== undefined && failed.length === 0;
    if (!ids) lines.push("Claude Code plugins: Fleet could not read the plugin list.");
    else lines.push(failed.length === 0 ? "Claude Code plugins: up to date." : `Claude Code plugins: ${failed.join(", ")} did not update.`);
  }
  const codex = await run(["codex", "plugin", "marketplace", "upgrade"]);
  if (codex.code === 127) lines.push("Codex plugins: codex is not installed, skipped.");
  else {
    ok &&= codex.code === 0;
    lines.push(codex.code === 0 ? "Codex plugins: up to date." : `Codex plugins: the marketplaces did not update (exit ${codex.code}).`);
  }
  return { ok, lines };
}

function userPlugins(out: string): string[] | undefined {
  try {
    const plugins = JSON.parse(out) as Array<{ id?: unknown; scope?: unknown }>;
    if (!Array.isArray(plugins)) return undefined;
    return plugins.flatMap((plugin) => plugin.scope === "user" && typeof plugin.id === "string" && pluginId.test(plugin.id) ? [plugin.id] : []);
  } catch {
    return undefined;
  }
}

export type T3Options = { busy: () => boolean; service: boolean; origin: () => string; wait: (ms: number) => Promise<void> };

const deferred = "T3 Code: an agent turn is running, so the update waits for the next run.";

export async function updateT3(run: Run, options: T3Options): Promise<{ ok: boolean; lines: string[] }> {
  if ((await run(["t3", "--version"])).code !== 0) return { ok: true, lines: ["T3 Code: not installed, skipped."] };
  if (options.busy()) return { ok: false, lines: [deferred] };
  const lines: string[] = [];
  if (options.service) {
    const compacted = await run(["t3", "doctor", "--fix"]);
    if (compacted.code !== 0) lines.push(`T3 Code: t3 doctor --fix failed (exit ${compacted.code}).`);
    if (options.busy()) return { ok: false, lines: [...lines, deferred] };
  }
  const updated = await run(["t3", "update", "--yes", "--channel", "nightly"]);
  if (updated.code !== 0) return { ok: false, lines: [...lines, `T3 Code: t3 update failed (exit ${updated.code}).`] };
  if (!options.service) return { ok: lines.length === 0, lines: [...lines, "T3 Code: the t3 CLI is up to date."] };
  let origin = "";
  for (let attempt = 1; attempt <= healthAttempts; attempt++) {
    if (attempt > 1) await options.wait(2000);
    origin = options.origin();
    const answer = await run(["curl", "--fail", "--silent", "--max-time", "5", `${origin}/.well-known/t3/environment`]);
    if (answer.code === 0 && describesServer(answer.out)) return { ok: lines.length === 0, lines: [...lines, "T3 Code: up to date, and its service answers."] };
  }
  return { ok: false, lines: [...lines, `T3 Code: updated, but its service at ${origin} does not answer. Run t3 service status.`] };
}

const healthAttempts = 10;

function describesServer(out: string): boolean {
  try {
    const descriptor = JSON.parse(out) as { environmentId?: unknown; serverVersion?: unknown };
    return typeof descriptor.environmentId === "string" && typeof descriptor.serverVersion === "string";
  } catch {
    return false;
  }
}

export function t3Busy(statePath: string): boolean {
  if (!existsSync(statePath)) return false;
  let db: Database | undefined;
  try {
    db = new Database(statePath, { readonly: true });
    const live = db.query("select 1 from sqlite_master where type = 'table' and name = 'orchestration_v2_projection_runs'").get();
    const table = live ? "orchestration_v2_projection_runs" : "projection_thread_sessions";
    const row = db.query(`select count(*) running from ${table} where status in ('queued', 'preparing', 'starting', 'running', 'waiting')`).get() as { running: number };
    return row.running > 0;
  } catch {
    return true;
  } finally {
    db?.close();
  }
}

function t3Origin(userdata: string): string {
  try {
    const runtime = JSON.parse(readFileSync(join(userdata, "server-runtime.json"), "utf8")) as { origin?: unknown };
    if (typeof runtime.origin === "string") return runtime.origin;
  } catch {}
  return "http://127.0.0.1:3773";
}

function t3State(userdata: string): string {
  const current = join(userdata, "statev2.sqlite");
  return existsSync(current) ? current : join(userdata, "state.sqlite");
}

function t3Home({ home, env }: Machine): string {
  const value = env.T3CODE_HOME?.trim() ?? "";
  if (!value) return join(home, ".t3");
  if (value === "~") return home;
  return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

export type Machine = { home: string; env: Record<string, string | undefined>; wait: (ms: number) => Promise<void> };

export async function nightlyAgentUpdate(run: Run, machine: Machine): Promise<{ ok: boolean; lines: string[] }> {
  const userdata = join(t3Home(machine), "userdata");
  const service = existsSync(join(machine.home, ".config/systemd/user/t3code.service"));
  const results = [
    await updateAgents(run),
    await updatePlugins(run),
    await updateT3(run, { busy: () => t3Busy(t3State(userdata)), service, origin: () => t3Origin(userdata), wait: machine.wait }),
  ];
  return { ok: results.every((result) => result.ok), lines: results.flatMap((result) => result.lines) };
}

async function runCommand(command: string[]) {
  try {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out };
  } catch {
    return { code: 127, out: "" };
  }
}

if (import.meta.main) {
  const { ok, lines } = await nightlyAgentUpdate(runCommand, { home: homedir(), env: process.env, wait: (ms) => Bun.sleep(ms) });
  for (const line of lines) console.log(line);
  process.exit(ok ? 0 : 1);
}
