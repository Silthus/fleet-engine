import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelFor, modelTable, type ModelRow } from "../../base/lib/models.ts";

export const families = ["claude", "gpt"] as const;
export type Family = (typeof families)[number];

export function family(value: string): Family {
  if (!(families as readonly string[]).includes(value)) throw new Error(`Unknown author family ${value}. Use claude or gpt`);
  return value as Family;
}

export function sessionFamily(env: Record<string, string | undefined>): Family | undefined {
  const [claude, gpt] = [Boolean(env.CLAUDE_CODE_SESSION_ID), Boolean(env.CODEX_THREAD_ID)];
  return claude === gpt ? undefined : claude ? "claude" : "gpt";
}

export const familyOf = (row: ModelRow): Family => row.provider === "claude" ? "claude" : "gpt";

export function reviewerRow(author: Family, env: Record<string, string | undefined>) {
  const codexReviewer = author === "gpt" ? modelTable(env).find((row) => row.role === "review-codex") : undefined;
  return codexReviewer ?? modelFor("review", env);
}

export function sameFamilyRow(author: Family, env: Record<string, string | undefined>) {
  const reviewers = modelTable(env).filter((row) => ["review", "review-codex"].includes(row.role));
  return reviewers.find((row) => familyOf(row) === author) ?? reviewerRow(author, env);
}

export type ModelAnswer = { ok: true; text: string; model: string } | { ok: false; cause: string; model: string };
export type ModelRequest = { prompt: string; cwd: string; readable?: string[]; images?: string[]; schema?: object; started?: (pid: number) => Promise<void> };
export type Role = "arbiter" | "reviewer" | "judge" | "eval-judge";

const prefixes: Record<Role, string> = { arbiter: "FLEET_REVIEW_ARBITER", reviewer: "FLEET_PROOF_REVIEWER", judge: "FLEET_PROOF_JUDGE", "eval-judge": "FLEET_PROOF_EVAL_JUDGE" };
const prefixOf = (role: Role) => prefixes[role];

export function modelLabel(role: Role, row: ModelRow, env: Record<string, string | undefined>) {
  const replacement = env[prefixOf(role)];
  return env[`${prefixOf(role)}_MODEL`] || (replacement ? `command: ${replacement}` : row.model);
}

export async function askModel(role: Role, row: ModelRow, request: ModelRequest, env: Record<string, string | undefined>, limit: number): Promise<ModelAnswer> {
  const prefix = prefixOf(role);
  const replacement = env[prefix];
  const model = modelLabel(role, row, env);
  const timeout = Number(env[`${prefix}_TIMEOUT_MS`]) || limit;
  const scratch = await mkdtemp(join(tmpdir(), "fleet-proof-model-"));
  try {
    const output = join(scratch, "answer.txt");
    const command = replacement ? ["sh", "-c", replacement] : await modelCommand({ ...row, model }, request, scratch, output);
    const answer = await spawnWithLimit(command, request, env, timeout);
    if (answer.cause !== undefined) return { ok: false, cause: answer.cause, model };
    const answersOnStdout = Boolean(replacement) || row.provider === "claude";
    const text = answersOnStdout ? answer.stdout : await readFile(output, "utf8").catch(() => "");
    return text.trim() ? { ok: true, text: text.trim(), model } : { ok: false, cause: "empty answer", model };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function modelCommand(row: ModelRow, request: ModelRequest, scratch: string, output: string) {
  if (row.provider === "claude") {
    return ["claude", "-p", "--model", row.model, "--effort", row.effort, "--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk",
      "--no-session-persistence", ...(request.readable ?? []).flatMap((directory) => ["--add-dir", directory])];
  }
  const schema = request.schema ? join(scratch, "schema.json") : undefined;
  if (schema) await writeFile(schema, JSON.stringify(request.schema));
  return ["codex", "exec", "-m", row.model, "-c", `model_reasoning_effort="${row.effort}"`, "-s", "read-only", "--ephemeral", "-C", request.cwd, "-o", output,
    ...(schema ? ["--output-schema", schema] : []), ...(request.images ?? []).flatMap((image) => ["-i", image]), "-"];
}

type Spawned = { stdout: string; cause?: undefined } | { stdout?: undefined; cause: string };

async function spawnWithLimit(command: string[], request: ModelRequest, env: Record<string, string | undefined>, timeout: number): Promise<Spawned> {
  let child: Bun.Subprocess<Blob, "pipe", "pipe"> | undefined;
  let stop: ReturnType<typeof setTimeout> | undefined;
  try {
    const running = child = Bun.spawn(command, { cwd: request.cwd, env: env as Record<string, string>, stdin: new Blob([request.prompt]), stdout: "pipe", stderr: "pipe", detached: true });
    stop = setTimeout(() => stopGroup(running.pid), timeout);
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited, request.started?.(child.pid)]);
    if (child.signalCode) return { cause: `stopped by ${child.signalCode} at the ${Math.round(timeout / 1000)} s limit` };
    if (code !== 0) return { cause: `exit ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)!.slice(0, 200)}` : ""}` };
    return { stdout };
  } catch (error) {
    if (child) { stopGroup(child.pid); await child.exited; }
    return { cause: (error as Error).message };
  } finally { clearTimeout(stop); }
}

function stopGroup(group: number) {
  try { process.kill(-group, "SIGKILL"); } catch {}
}

export async function readRubric(home: string) {
  const standards = (await readFile(join(home, ".agents/guides/coding-standards.md"), "utf8").catch(() => "")).trim();
  if (!standards) throw new Error("~/.agents/guides/coding-standards.md is missing or empty; it holds the coding standards to review against");
  return standards;
}

export const skillReferences = (home: string) => ["tdd", "codebase-design"].map((skill) => join(home, ".agents/skills", skill, "SKILL.md"));
