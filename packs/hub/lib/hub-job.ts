import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelFor } from "../../base/lib/models.ts";
import type { Env, Result } from "./coder.ts";
import { quote, readRole } from "./machine.ts";

export type JobContext = { home: string; env: Env; self: string; now(): number; log(line: string): void };
export type Timer = (ms: number, fire: () => void) => () => void;

const drainMs = 5_000;
const lockBusy = 75;
const timedOut = 124;

export const stateDir = (home: string, env: Env) => join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "fleet");
export const sshArgv = (host: string, command: string) => ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command];

const realTimer: Timer = (ms, fire) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

async function collect(stream: ReadableStream<Uint8Array>, cutOff: Promise<void>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const stopped = cutOff.then(() => undefined);
  let text = "";
  for (;;) {
    const next = await Promise.race([reader.read(), stopped]);
    if (!next) { reader.cancel().catch(() => {}); return text + decoder.decode(); }
    if (next.done) return text + decoder.decode();
    text += decoder.decode(next.value, { stream: true });
  }
}

export async function spawnText(argv: string[], env: Env, options: { stdin?: string; timeoutMs: number; cwd?: string; after?: Timer }): Promise<Result> {
  const after = options.after ?? realTimer;
  const child = Bun.spawn(argv, {
    cwd: options.cwd, env: env as Record<string, string>, stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe", stderr: "pipe", detached: true,
  });
  let killed = false;
  let endDrain = () => {};
  const drained = new Promise<void>((resolve) => { endDrain = resolve; });
  const cancelDeadline = after(options.timeoutMs, () => {
    killed = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    after(drainMs, endDrain);
  });
  try {
    const [stdout, stderr, code] = await Promise.all([collect(child.stdout, drained), collect(child.stderr, drained), Promise.race([child.exited, drained.then(() => timedOut)])]);
    return { code: killed ? timedOut : code, stdout, stderr };
  } finally { cancelDeadline(); }
}

export function requireHubRole(home: string, command: string): void {
  const role = readRole(home);
  if (role !== "hub") throw new Error(`fleet ${command} runs only on the hub. This machine's role is ${role ?? "not set"}. Run fleet hub here on the hub, or run this there.`);
}

function takeLock(path: string, env: Env): (() => void) | undefined {
  const flock = Bun.which("flock", { PATH: env.PATH ?? "" });
  if (!flock) throw new Error("Hub jobs need flock from util-linux, and this machine has none on PATH.");
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  const locked = Bun.spawnSync([flock, "-n", "-E", String(lockBusy), "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
  if (locked.exitCode === 0) return () => closeSync(fd);
  closeSync(fd);
  if (locked.exitCode === lockBusy) return undefined;
  throw new Error(`flock could not lock ${path}: ${locked.stderr?.toString().trim()}`);
}

export async function underLock(context: JobContext, name: string, label: string, work: () => Promise<number>): Promise<number> {
  const release = takeLock(join(stateDir(context.home, context.env), `${name}.lock`), context.env);
  if (!release) {
    context.log(`${label} is already running, so this run ends.`);
    return 0;
  }
  try { return await work(); }
  finally { release(); }
}

export type ThreadModel = { provider: string; model: string };

const t3Providers = { claude: "claudeAgent", codex: "codex" } as const;

export function threadModel(role: string, fallback: string, env: Env): ThreadModel {
  try {
    const row = modelFor(role, env);
    return { provider: t3Providers[row.provider], model: row.model };
  } catch { return { provider: t3Providers.claude, model: fallback }; }
}

export function writeStateFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  writeFileSync(partial, `${JSON.stringify(value)}\n`, { flag: "wx" });
  renameSync(partial, path);
}

const shellPath = (path: string) => (path === "~" ? `"$HOME"` : path.startsWith("~/") ? `"$HOME"/${quote(path.slice(2))}` : quote(path));

export function threadScript(folder: string, title: string, choice: ThreadModel): string {
  return [
    `prompt=$(mktemp) || exit 1`,
    `trap 'rm -f "$prompt"' EXIT`,
    `cat > "$prompt"`,
    `folder=${shellPath(folder)}`,
    `t3 project add "$folder" >/dev/null 2>&1 || :`,
    `t3 thread start --title ${quote(title)} --provider ${quote(choice.provider)} --model ${quote(choice.model)} "$folder" - < "$prompt"`,
  ].join("\n");
}
