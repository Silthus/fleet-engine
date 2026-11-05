import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ModelRow } from "../../../base/lib/models.ts";
import type { Env } from "../coder.ts";
import { memoryCheckout, stateDir, type Digest } from "./digest.ts";
import { recordRuns } from "./scorecard.ts";

export type Finding = { kind: string; scope: string; reach: "one-off" | "general"; claim: string; evidence: string; memory: string; importance: number; topic?: string };
export type Findings = { taskType?: string; findings: Finding[] };
export type Analyst = (item: Digest, index: string, run: string) => Promise<Findings>;
export type AnalyzeIo = { home: string; env: Env; limit: number; jobs: number; analyst: Analyst; say(line: string): void };
type Seen = Record<string, string>;
export type Unreached = { machine: string; reason: string };

const digestLimit = 40_000;
export const analystTimeoutMs = 10 * 60_000;

export function readFindings(path: string): Findings {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed) ? { findings: parsed } : parsed;
}

export const analystPrompt = `You review one condensed agent session for the person who runs Claude Code and Codex agents across several machines.
The agents share a memory of Markdown files. Its index is below. Report what future agents should know so they do better:

- correction: the person corrected the agent or rejected its approach.
- preference: the person stated or confirmed how they want something done. A choice the agent made is never a preference.
- repeated-failure: the agent hit the same error or dead end more than once, with the cause when visible.
- missing-knowledge: the agent spent many steps finding a fact that one memory line would have given it.
- tool-problem: a tool, script, config, or environment misbehaved; this needs a fix, not a memory.
- stale-memory: the session shows a memory in the index is wrong or outdated. Name the memory file.
- memory-helped: a memory in the index saved the agent work. Name the memory file.

Write each claim as one sentence a future agent can act on, in plain English. Quote short evidence from the session.
Scope is "global" or the repository name. Importance: 3 costs real time or annoys the person, 1 is minor.
Reach is "general" only when the person states a rule for how they work everywhere ("always", "never", "from now on")
or the same lesson would recur in other tasks. A decision for this PR, ticket, map, or task is "one-off", even when
the person states it firmly. Product and architecture decisions are "one-off": they belong in the repository's docs.
Topic is a kebab-case slug for the lesson, the same for the same lesson in every session. When a memory in the index
covers the lesson, the topic is that memory's file name without its directory and ".md". Otherwise name the lesson's
subject in two to five words, such as "pkill-f-kills-own-shell".
Report nothing that the code or git history shows, nothing about this one task's details, and no secrets or tokens.
An ordinary session with no lesson returns an empty list.
Also label the session's task type: build (a feature or UI), fix (a bug), review (reviewing or proving a PR),
research (a question or investigation without a code change), ops (machines, deploys, rollouts, watching PRs),
chore (docs, config, small edits), or other.`;

export const taskTypes = ["build", "fix", "review", "research", "ops", "chore", "other"] as const;

const analystSchema = {
  type: "object", required: ["taskType", "findings"], additionalProperties: false,
  properties: {
    taskType: { enum: taskTypes },
    findings: {
      type: "array", maxItems: 8,
      items: {
        type: "object", required: ["kind", "topic", "scope", "reach", "claim", "evidence", "memory", "importance"], additionalProperties: false,
        properties: {
          topic: { type: "string" },
          kind: { enum: ["correction", "preference", "repeated-failure", "missing-knowledge", "tool-problem", "stale-memory", "memory-helped"] },
          scope: { type: "string" }, reach: { enum: ["one-off", "general"] }, claim: { type: "string" }, evidence: { type: "string" },
          memory: { type: "string", description: "The memory file this confirms or contradicts, or an empty string" },
          importance: { type: "integer", minimum: 1, maximum: 3 },
        },
      },
    },
  },
};

export function render(item: Digest): string {
  const head = [`Machine: ${item.machine}`, `Agent: ${item.provider} ${item.model}`, `Repository: ${item.repo} (${item.cwd})`,
    `Time: ${item.startedAt} to ${item.endedAt}`, `Tool calls: ${item.toolCalls}`, `Skills: ${[...new Set(item.skills)].join(", ") || "none"}`,
    `Memory read: ${[...new Set(item.memoryReads)].join(", ") || "none"}`, ""].join("\n");
  const shown = item.entries.map((entry) => `[${entry.role}] ${entry.text}`);
  const text = shown.join("\n\n");
  if (head.length + text.length <= digestLimit) return head + text;
  const first = shown.slice(0, 6);
  const last: string[] = [];
  let size = head.length + first.join("\n\n").length + 100;
  for (let index = shown.length - 1; index >= first.length && size + shown[index]!.length < digestLimit; index--) {
    last.unshift(shown[index]!);
    size += shown[index]!.length + 2;
  }
  return head + [...first, `[… ${shown.length - first.length - last.length} entries left out …]`, ...last].join("\n\n");
}

const codexToolsOff = ["shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "multi_agent", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "in_app_browser", "computer_use", "image_generation", "view_image", "code_mode_host", "hooks", "shell_snapshot", "skill_mcp_dependency_install", "tool_suggest",
  "sleep_tool", "goals", "workspace_dependencies"];

export function analystCommand(row: ModelRow, scratch: string): string[] {
  if (row.provider === "claude") {
    return ["claude", "-p", "--model", row.model, "--effort", row.effort, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--disable-slash-commands", "--no-session-persistence", "--tools", "", "--system-prompt", analystPrompt, "--output-format", "json", "--json-schema", JSON.stringify(analystSchema)];
  }
  return ["codex", "exec", "--ignore-user-config", "-m", row.model, "-c", `model_reasoning_effort="${row.effort}"`, "-c", 'web_search="disabled"',
    "-c", 'approvals_reviewer="user"', ...codexToolsOff.flatMap((feature) => ["--disable", feature]), "-s", "read-only", "--ephemeral", "--skip-git-repo-check",
    "-C", scratch, "--output-schema", join(scratch, "schema.json"), "-o", join(scratch, "answer.json"), "-"];
}

export type Spawn = (argv: string[], options: { cwd: string; env: Env; stdin: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; timedOut?: boolean }>;

function claudeEnv(home: string, env: Env): Env {
  const path = join(home, ".claude/settings.json");
  const settings = existsSync(path) ? ((JSON.parse(readFileSync(path, "utf8")) as { env?: Env }).env ?? {}) : {};
  return { ...env, ...settings, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
}

function checked(answer: { code: number; timedOut?: boolean }) {
  if (answer.timedOut) throw new Error(`analyst stopped at its ${analystTimeoutMs / 60_000} minute limit`);
  if (answer.code !== 0) throw new Error(`analyst exited with ${answer.code}`);
}

export function modelAnalyst(row: ModelRow, home: string, env: Env, spawn: Spawn): Analyst {
  return async (item, index, run) => {
    const input = `Memory index:\n${index}\n\nSession:\n${render(item)}`;
    if (row.provider === "claude") {
      const answer = await spawn(analystCommand(row, run), { cwd: run, env: claudeEnv(home, env), stdin: input, timeoutMs: analystTimeoutMs });
      checked(answer);
      const parsed = JSON.parse(answer.stdout) as { is_error?: boolean; structured_output?: Findings; result?: unknown };
      if (parsed.is_error || !parsed.structured_output) throw new Error(`analyst returned no findings: ${String(parsed.result).slice(0, 200)}`);
      return parsed.structured_output;
    }
    const scratch = mkdtempSync(join(tmpdir(), "fleet-dream-analyst-"));
    try {
      writeFileSync(join(scratch, "schema.json"), JSON.stringify(analystSchema));
      const answer = await spawn(analystCommand(row, scratch), { cwd: scratch, env, stdin: `${analystPrompt}\n\n${input}`, timeoutMs: analystTimeoutMs });
      checked(answer);
      return JSON.parse(readFileSync(join(scratch, "answer.json"), "utf8")) as Findings;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}

const weight = (item: Digest) => item.entries.filter((entry) => entry.role === "user").length * 2 + item.entries.filter((entry) => entry.role === "error").length;

export function readSeen(state: string): Seen {
  const path = join(state, "seen.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

export const unreachedPath = (run: string) => join(run, "unreached.json");

function readUnreached(run: string): Unreached[] {
  return existsSync(unreachedPath(run)) ? JSON.parse(readFileSync(unreachedPath(run), "utf8")) : [];
}

export async function analyze(run: string, io: AnalyzeIo): Promise<string> {
  const state = stateDir(io.home, io.env);
  const indexPath = join(memoryCheckout(io.home, io.env), "MEMORY.md");
  const index = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "(empty)";
  mkdirSync(join(run, "findings"), { recursive: true });
  const all = readdirSync(join(run, "digests")).sort().map((file) => ({ file, item: JSON.parse(readFileSync(join(run, "digests", file), "utf8")) as Digest }));
  all.sort((a, b) => weight(b.item) - weight(a.item));
  const chosen = all.slice(0, io.limit).filter(({ file }) => !existsSync(join(run, "findings", file)));
  const failed: string[] = [];
  const analyzed: Digest[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: io.jobs }, async () => {
    while (next < chosen.length) {
      const { file, item } = chosen[next++]!;
      try {
        writeFileSync(join(run, "findings", file), JSON.stringify(await io.analyst(item, index, run)));
        analyzed.push(item);
      } catch (error) {
        failed.push(`${file}: ${(error as Error).message}`);
      }
    }
  }));
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const seen = readSeen(state);
  for (const item of analyzed) {
    const key = `${item.provider}:${item.session}`;
    if ((seen[key] ?? "") < item.endedAt) seen[key] = item.endedAt;
  }
  writeFileSync(join(state, "seen.json"), JSON.stringify(seen));
  recordRuns(state);
  writeFileSync(join(run, "findings.md"), report(run, all, all.length - io.limit, failed));
  if (chosen.length && failed.length === chosen.length) throw new Error(`every analyst failed, the first on ${failed[0]}. Findings: ${join(run, "findings.md")}`);
  io.say(`Fleet dream: analyzed ${chosen.length - failed.length} of ${all.length} sessions${failed.length ? `, ${failed.length} failed: ${failed.join("; ")}` : ""}. Findings: ${join(run, "findings.md")}`);
  return run;
}

function report(run: string, all: Array<{ file: string; item: Digest }>, cut: number, failed: string[]): string {
  const byKind = new Map<string, string[]>();
  const machines = new Set<string>();
  const unreached = readUnreached(run);
  let analyzed = 0;
  for (const { file, item } of all) {
    const path = join(run, "findings", file);
    if (!existsSync(path)) continue;
    analyzed++;
    machines.add(item.machine);
    for (const finding of readFindings(path).findings) {
      const kind = finding.reach === "one-off" ? "one-off" : finding.kind;
      const lines = byKind.get(kind) ?? [];
      lines.push(`- (${finding.importance}) [${kind === "one-off" ? `${finding.kind}, ` : ""}${finding.scope}] {${finding.topic ?? "no topic"}} ${finding.claim}${finding.memory ? ` Memory: \`${finding.memory}\`.` : ""}\n  Evidence: ${finding.evidence.replaceAll("\n", " ")}\n  Session: ${item.machine} ${item.provider} ${item.session} (${item.repo})`);
      byKind.set(kind, lines);
    }
  }
  const order = ["correction", "preference", "repeated-failure", "missing-knowledge", "stale-memory", "memory-helped", "tool-problem", "one-off"];
  return [
    `# Dream findings ${basename(run)}`, "",
    `${analyzed} sessions analyzed from ${machines.size} machines (${[...machines].sort().join(", ")}).`,
    unreached.length ? `Not reached: ${unreached.map((item) => `${item.machine} (${item.reason})`).join(", ")}.` : "",
    cut > 0 ? `${cut} sessions with the fewest messages were left out by --limit.` : "",
    failed.length ? `Analysts failed on:\n${failed.map((line) => `- ${line}`).join("\n")}` : "", "",
    ...order.filter((kind) => byKind.has(kind)).flatMap((kind) => [`## ${kind} (${byKind.get(kind)!.length})`, "", ...byKind.get(kind)!, ""]),
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
}
