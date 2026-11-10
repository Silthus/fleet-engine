import type { Action, Finding, Plan } from "../../pack/types.ts";
import type { CommandRunner } from "../run.ts";
import { keyPath, same } from "./fields.ts";
import { inside } from "../../files/install.ts";
import { linkOnPath, optional, readState, writeWithBackups } from "./store.ts";

export const claudeJson = ".claude.json";
export const serversTarget = ".config/fleet/claude-servers.json";

/** value is what the pack asked for; stored is what Claude Code wrote for it, which can differ in shape. */
type Owned = { name: string; value: unknown; stored: unknown; pack: string };
type Wanted = { name: string; value: unknown; pack: string };
type Result = { actions: Action[]; findings: Finding[] };

export const isMcpServer = (path: string[]) => path[0] === "mcpServers";

export function wantedServers(plan: Plan): Wanted[] {
  return plan.config.flatMap((entry) => (entry.provider === "claude" && isMcpServer(keyPath(entry.key)) ? [{ name: keyPath(entry.key)[1]!, value: entry.value, pack: entry.pack }] : []));
}

const finding = (id: string, say: string, repair?: Finding["repair"]): Finding => ({ id, pack: "engine", say, ...(repair ? { repair } : {}) });

/**
 * Claude Code runs without CLAUDE_CONFIG_DIR, so it writes the ~/.claude.json that Fleet reads.
 * Adds and removes the Claude MCP servers packs declare through claude mcp, so Claude Code writes ~/.claude.json itself.
 * Claude Code saves that file from several paths, not all of them locked, so no other writer can avoid racing it.
 */
export async function reconcileServers(plan: Plan, home: string, options: { dryRun: boolean; adopt: boolean; outage: boolean; gated: string[]; run: CommandRunner }): Promise<Result> {
  const result: Result = { actions: [], findings: [] };
  const wanted = wantedServers(plan);
  const recordText = await readState(home, serversTarget);
  const previous = parseOwned(recordText);
  if (!wanted.length && !previous.length) return result;
  let servers: Record<string, unknown>;
  try {
    servers = await currentServers(home);
  } catch (error) {
    result.findings.push(finding(`kept:${claudeJson}`, `Kept ${claudeJson} as it is: Fleet cannot read it (${(error as Error).message}). Fix the file, then run fleet apply.`, "human"));
    return result;
  }
  const next: Owned[] = [];
  const add: Wanted[] = [];
  const remove: string[] = [];
  const kept: string[] = [];
  for (const server of wanted) {
    const old = previous.find((item) => item.name === server.name);
    const current = servers[server.name];
    if (old && same(old.value, server.value) && same(current, old.stored)) next.push({ ...old, pack: server.pack });
    else if (current !== undefined && !(old && same(current, old.stored)) && !same(current, server.value) && !options.adopt) {
      kept.push(`mcpServers.${server.name}`);
      if (old) next.push(old);
    } else {
      if (current !== undefined) remove.push(server.name);
      add.push(server);
    }
  }
  for (const old of previous) {
    if (wanted.some((server) => server.name === old.name)) continue;
    if (options.outage && !options.gated.includes(`claude:mcpServers.${old.name}`)) next.push(old);
    else if (same(servers[old.name], old.stored)) remove.push(old.name);
  }
  if (kept.length) result.findings.push(finding(`kept:${claudeJson}`, `Kept your ${kept.join(", ")} in ${claudeJson}. Run fleet apply --adopt ${claudeJson} to take Fleet's value.`));
  const removedOnly = remove.filter((name) => !add.some((server) => server.name === name));
  const reason = [add.length ? `set ${add.map((server) => `mcpServers.${server.name}`).join(", ")}` : "", removedOnly.length ? `remove ${removedOnly.map((name) => `mcpServers.${name}`).join(", ")}` : ""].filter(Boolean).join("; ");
  if (reason && (await linkOnPath(home, claudeJson))) {
    result.findings.push(finding(`kept:${claudeJson}`, `Kept ${claudeJson} because it is a link or sits in a linked folder. Fleet would ${reason} there. Make it a plain file in a plain folder to let Fleet change it.`));
    return result;
  }
  if (options.dryRun) {
    if (reason) result.findings.push(finding(`config:${claudeJson}`, `${claudeJson} needs an update: ${reason}.`, "apply"));
    return result;
  }
  const claude = (args: string[]) => options.run(["claude", "mcp", ...args, "--scope", "user"], { home, clearEnv: ["CLAUDE_CONFIG_DIR"] });
  const blocked = new Set<string>();
  for (const name of remove) {
    const removed = await claude(["remove", name]);
    if (removed.code === 127) return waiting(result, wanted);
    if (removed.code === 0) continue;
    blocked.add(name);
    const old = previous.find((item) => item.name === name);
    if (old) next.push(old);
    result.findings.push(finding(`claude-server:${name}`, `Claude Code did not remove the MCP server ${name}: ${firstLine(removed)}. Run fleet apply again.`, "apply"));
  }
  const added: Wanted[] = [];
  for (const server of add.filter((item) => !blocked.has(item.name))) {
    const outcome = await claude(["add-json", server.name, JSON.stringify(server.value)]);
    if (outcome.code === 127) return waiting(result, wanted);
    if (outcome.code === 0) added.push(server);
    else result.findings.push(finding(`claude-server:${server.name}`, `Claude Code did not add the MCP server ${server.name}: ${firstLine(outcome)}. Check its value in the ${server.pack} pack.`, "apply"));
  }
  const after = await currentServers(home);
  for (const server of added) if (after[server.name] !== undefined) next.push({ ...server, stored: after[server.name] });
  if (reason) result.actions.push({ target: claudeJson, operation: "replace", reason });
  const text = `${JSON.stringify({ servers: next }, null, 2)}\n`;
  if (text !== recordText && (next.length || recordText !== undefined)) await writeWithBackups(home, [{ target: serversTarget, before: recordText, after: text }]);
  return result;
}

function waiting(result: Result, wanted: Wanted[]) {
  result.findings.push(finding("claude-servers", `Claude Code is not installed yet, so its MCP servers wait: ${wanted.map((server) => server.name).join(", ")}.`, "apply"));
  return result;
}

const firstLine = (output: { stdout: string; stderr?: string }) => (output.stderr || output.stdout).trim().split("\n")[0] || "no output";

async function currentServers(home: string): Promise<Record<string, unknown>> {
  const text = await optional(inside(home, claudeJson));
  if (text === undefined) return {};
  const servers = (JSON.parse(text) as { mcpServers?: unknown }).mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, unknown>) : {};
}

function parseOwned(text: string | undefined): Owned[] {
  if (text === undefined) return [];
  const value = JSON.parse(text) as { servers?: Owned[] };
  if (!Array.isArray(value?.servers) || value.servers.some((server) => typeof server?.name !== "string" || typeof server.pack !== "string")) throw new Error(`${serversTarget} is not a Claude server record`);
  return value.servers;
}
