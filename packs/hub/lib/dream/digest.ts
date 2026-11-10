import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { BoxHooks } from "../box.ts";
import type { Coder, Env } from "../coder.ts";
import { remoteFleet } from "../machine.ts";
import { notesShownByTrigger } from "../../../memory/lib/notes.ts";
import { redactCredentials, redactValue } from "./redact.ts";

type Entry = { at: string; role: "user" | "assistant" | "error"; text: string };
export type Effort = { tokens: number; toolCalls: number; errors: number; seconds: number };
export type Digest = {
  machine: string; provider: "claude" | "codex"; session: string; cwd: string; repo: string; model: string;
  startedAt: string; endedAt: string; toolCalls: number; skills: string[]; memoryReads: string[]; memoryWrites: string[]; memoryShown?: string[];
  tokens: number; effort?: Effort; entries: Entry[];
};

const day = 86_400_000;
const userLimit = 2000;
const assistantLimit = 800;
const errorLimit = 400;
export const dreamSessionsKey = "hub.dreamSessions";
export const dreamPromptStart = "Follow the dream skill";

export const stateDir = (home: string, env: Env) => join(env.XDG_STATE_HOME || join(home, ".local/state"), "fleet/dream");
export const inboxDir = (home: string, env: Env) => join(stateDir(home, env), "inbox");
export const memoryCheckout = (home: string, env: Env) => env.FLEET_MEMORY_DIR || join(home, ".agents/memory");
export const clip = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit)} […${text.length - limit} more]`;
const keep = (text: string, limit: number) => clip(redactCredentials(text), limit);
const failure = (call: string | undefined, output: string) => clip(`${call ?? "tool"} → ${redactCredentials(output.trim())}`, errorLimit);
const stripReminders = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

const isoTime = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export function parseSince(value: string | undefined, now: number): number {
  if (!value) return now - 2 * day;
  const relativeTime = /^(\d+)([dh])$/.exec(value);
  if (relativeTime) return now - Number(relativeTime[1]) * (relativeTime[2] === "d" ? day : 3_600_000);
  const at = isoTime.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) throw new Error(`Cannot read --since ${value}. Use 2d, 36h, or an ISO time.`);
  return at;
}

export function repoOf(cwd: string, home: string): string {
  const path = relative(home, cwd);
  if (path.startsWith(".t3/scratch")) return "scratch";
  const named = /^\.t3\/worktrees\/([^/]+)/.exec(path) ?? /^dev\/([^/]+)/.exec(path) ?? /^([^/.][^/]*)/.exec(path);
  return named?.[1] ?? "home";
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function memoryMatcher(home: string, env: Env): (text: string) => string[] {
  const checkout = resolve(memoryCheckout(home, env));
  const fromHome = relative(home, checkout);
  const roots = [checkout, ...(fromHome && !fromHome.startsWith("..") ? [fromHome] : [])].map(escaped);
  const pattern = new RegExp(String.raw`(?<![\w-])(?:${roots.join("|")})/([\w./-]+\.md)`, "g");
  return (text) => [...text.matchAll(pattern)].map((match) => match[1]!);
}

function blank(machine: string, provider: Digest["provider"]): Digest {
  return { machine, provider, session: "", cwd: "", repo: "", model: "", startedAt: "", endedAt: "", toolCalls: 0, skills: [], memoryReads: [], memoryWrites: [], tokens: 0, entries: [] };
}

class EffortMeter {
  private toolCalls = 0;
  private errors = 0;
  effort?: Effort;
  call() { if (!this.effort) this.toolCalls++; }
  error() { if (!this.effort) this.errors++; }
  edit(at: string, startedAt: string, tokens: number) {
    if (this.effort) return;
    const seconds = Math.max(0, Math.round((Date.parse(at) - Date.parse(startedAt)) / 1000)) || 0;
    this.effort = { tokens, toolCalls: this.toolCalls, errors: this.errors, seconds };
  }
}

type Line = Record<string, any>;

function* lines(path: string): Generator<Line> {
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") yield parsed;
    } catch {}
  }
}

function toolText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => typeof block?.text === "string" ? block.text : "").join("\n");
  return JSON.stringify(content ?? "");
}

const claudeEdits = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const usageTotal = (usage: Record<string, unknown> = {}) =>
  count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens) + count(usage.output_tokens);

export function digestClaude(path: string, machine: string, home: string, env: Env): Digest {
  const digest = blank(machine, "claude");
  const memoryPaths = memoryMatcher(home, env);
  const calls = new Map<string, string>();
  const reads = new Map<string, string[]>();
  const spent = new Map<string, number>();
  const tokens = () => [...spent.values()].reduce((sum, value) => sum + value, 0);
  const meter = new EffortMeter();
  for (const line of lines(path)) {
    if (line.isSidechain || line.isMeta) continue;
    if (line.sessionId && !digest.session) digest.session = line.sessionId;
    if (line.cwd && !digest.cwd) digest.cwd = line.cwd;
    const at: string = typeof line.timestamp === "string" ? line.timestamp : digest.endedAt;
    if (line.type !== "user" && line.type !== "assistant") continue;
    if (at) { digest.startedAt ||= at; digest.endedAt = at; }
    const content = line.message?.content;
    if (line.type === "assistant" && line.message?.model) digest.model = line.message.model;
    if (line.type === "assistant" && line.message?.usage) {
      const id = line.message.id ?? line.uuid;
      spent.set(id, Math.max(spent.get(id) ?? 0, usageTotal(line.message.usage)));
    }
    const blocks: Line[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        const text = line.type === "user" ? stripReminders(block.text) : block.text.trim();
        if (!text || (line.type === "user" && /^<(command-|local-command|task-notification|bash-)/.test(text))) continue;
        digest.entries.push({ at, role: line.type, text: keep(text, line.type === "user" ? userLimit : assistantLimit) });
      } else if (block.type === "tool_use") {
        digest.toolCalls++;
        meter.call();
        const input = block.input ?? {};
        const shown = JSON.stringify(input);
        calls.set(block.id, `${block.name} ${keep(shown, 200)}`);
        if (block.name === "Skill" && typeof input.skill === "string") digest.skills.push(input.skill);
        const target = memoryPaths(typeof input.file_path === "string" ? input.file_path : shown);
        const edits = claudeEdits.includes(block.name);
        if (edits) digest.memoryWrites.push(...target);
        else reads.set(block.id, target);
        if (edits && !target.length) meter.edit(at, digest.startedAt, tokens());
      } else if (block.type === "tool_result" && block.is_error) {
        meter.error();
        digest.entries.push({ at, role: "error", text: failure(calls.get(block.tool_use_id), toolText(block.content)) });
      }
    }
  }
  digest.memoryReads = [...reads.values()].flat();
  digest.tokens = tokens();
  if (meter.effort) digest.effort = meter.effort;
  digest.repo = repoOf(digest.cwd, home);
  return digest;
}

const codexFailure = /exit code[:\s]+[1-9]|"exit_code":\s*[1-9]|Process exited with code [1-9]/i;

export function digestCodex(path: string, machine: string, home: string, env: Env): Digest {
  const digest = blank(machine, "codex");
  const memoryPaths = memoryMatcher(home, env);
  const calls = new Map<string, string>();
  const reads = new Map<string, string[]>();
  const meter = new EffortMeter();
  for (const line of lines(path)) {
    const payload = line.payload ?? {};
    const at: string = typeof line.timestamp === "string" ? line.timestamp : digest.endedAt;
    if (line.type === "session_meta") { digest.session = payload.id ?? digest.session; digest.cwd = payload.cwd ?? digest.cwd; continue; }
    if (line.type === "turn_context" && payload.model) { digest.model = payload.model; continue; }
    if (line.type === "event_msg" && payload.type === "token_count") { digest.tokens = count(payload.info?.total_token_usage?.total_tokens ?? digest.tokens); continue; }
    if (line.type !== "response_item") continue;
    if (at) { digest.startedAt ||= at; digest.endedAt = at; }
    if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const text = toolText(payload.content).trim();
      if (!text || (payload.role === "user" && /^(<|# AGENTS\.md)/.test(text))) continue;
      digest.entries.push({ at, role: payload.role, text: keep(text, payload.role === "user" ? userLimit : assistantLimit) });
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      digest.toolCalls++;
      meter.call();
      const input = String(payload.arguments ?? payload.input ?? "");
      calls.set(payload.call_id, `${payload.name} ${keep(input, 200)}`);
      const touched = memoryPaths(input);
      const edits = payload.name === "apply_patch" || /\*\*\* (Add|Update|Delete) File/.test(input);
      if (edits) digest.memoryWrites.push(...touched);
      else reads.set(payload.call_id, touched);
      if (edits && !touched.length) meter.edit(at, digest.startedAt, digest.tokens);
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const output = toolText(typeof payload.output === "object" && payload.output?.content ? payload.output.content : payload.output);
      if (codexFailure.test(output.slice(0, 300))) {
        meter.error();
        digest.entries.push({ at, role: "error", text: failure(calls.get(payload.call_id), output) });
      }
    }
  }
  digest.memoryReads = [...reads.values()].flat();
  if (meter.effort) digest.effort = meter.effort;
  digest.repo = repoOf(digest.cwd, home);
  return digest;
}

function filesSince(root: string, since: number, match: (path: string) => boolean, depth: number): string[] {
  if (!existsSync(root) || depth < 0) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "subagents" && entry.name !== "memory") found.push(...filesSince(path, since, match, depth - 1));
    } else if (match(path) && statSync(path).mtimeMs >= since) found.push(path);
  }
  return found;
}

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

function belongsToDream(digest: Digest, home: string, env: Env): boolean {
  const opening = digest.entries.find((entry) => entry.role === "user")?.text ?? "";
  return within(digest.cwd, memoryCheckout(home, env)) || within(digest.cwd, stateDir(home, env)) || opening.startsWith(dreamPromptStart);
}

export function localDigests(home: string, machine: string, since: number, env: Env, dreams = false): Digest[] {
  const claude = filesSince(join(home, ".claude/projects"), since, (path) => path.endsWith(".jsonl"), 1).map((path) => digestClaude(path, machine, home, env));
  const codex = filesSince(join(home, ".codex/sessions"), since, (path) => /rollout-.*\.jsonl$/.test(path), 4).map((path) => digestCodex(path, machine, home, env));
  const cutoff = new Date(since).toISOString();
  const chosen = [...claude, ...codex].filter((digest) => belongsToDream(digest, home, env) === dreams);
  for (const item of chosen) {
    item.entries = item.entries.filter((entry) => !entry.at || entry.at >= cutoff);
    const shown = notesShownByTrigger(home, item.session);
    if (shown.length) item.memoryShown = shown;
  }
  return chosen.filter((digest) => digest.session && digest.entries.some((entry) => entry.role === "user"));
}

export function redactDigest(item: Digest): Digest {
  const { tokens, effort, ...text } = item;
  const counted = effort && { tokens: count(effort.tokens), toolCalls: count(effort.toolCalls), errors: count(effort.errors), seconds: count(effort.seconds) };
  return { ...item, ...(redactValue(text) as Omit<Digest, "tokens" | "effort">), tokens: count(tokens), ...(counted ? { effort: counted } : {}) };
}

export function digestLines(home: string, machine: string, since: number, now: number, env: Env): string {
  let output = localDigests(home, machine, since, env).map((item) => `${JSON.stringify(redactDigest(item))}\n`).join("");
  const inbox = inboxDir(home, env);
  for (const file of existsSync(inbox) ? readdirSync(inbox).sort() : []) {
    const path = join(inbox, file);
    const modified = statSync(path).mtimeMs;
    if (modified < now - 14 * day) rmSync(path, { force: true });
    else if (modified >= since) output += readFileSync(path, "utf8");
  }
  return output;
}

export async function saveBoxDigests(coder: Pick<Coder, "ssh">, box: string, home: string, env: Env, now: () => number = Date.now): Promise<void> {
  try {
    const answer = await coder.ssh(box, remoteFleet("dream digest --since 30d"), undefined, 90_000);
    if (answer.code !== 0 || !answer.stdout.trim()) return;
    mkdirSync(inboxDir(home, env), { recursive: true, mode: 0o700 });
    writeFileSync(join(inboxDir(home, env), `${box}-${now()}.jsonl`), answer.stdout, { mode: 0o600 });
  } catch (error) {
    console.error(`Fleet dream: kept no sessions of ${box}: ${(error as Error).message}`);
  }
}

export function dreamIsOn(env: Env): boolean {
  return env.FLEET_SETTINGS ? dreamSessionsKey in (JSON.parse(env.FLEET_SETTINGS) as Record<string, unknown>) : false;
}

export function dreamHooks(env: Env, home: string, coder: () => Pick<Coder, "ssh">): BoxHooks {
  return dreamIsOn(env) ? { stopping: (box) => saveBoxDigests(coder(), box, home, env) } : {};
}
