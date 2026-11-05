import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelFor } from "../../base/lib/models.ts";
import type { Env, Result } from "./coder.ts";
import { quote, readRole } from "./machine.ts";

export type JobContext = { home: string; env: Env; self: string; now(): number; log(line: string): void; pid?: number; alive?(pid: number): boolean; beforeTakeover?(): void };

const unclaimedLockMs = 60_000;

export const stateDir = (home: string, env: Env) => join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "fleet");
export const sshArgv = (host: string, command: string) => ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command];

export async function spawnText(argv: string[], env: Env, options: { stdin?: string; timeoutMs: number; cwd?: string }): Promise<Result> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd, env: env as Record<string, string>, stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe", stderr: "pipe", timeout: options.timeoutMs, killSignal: "SIGKILL",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code: child.signalCode ? 124 : code, stdout, stderr };
}

export function requireHubRole(home: string, command: string): void {
  const role = readRole(home);
  if (role !== "hub") throw new Error(`fleet ${command} runs only on the hub. This machine's role is ${role ?? "not set"}. Run fleet hub here on the hub, or run this there.`);
}

const isAlive = (pid: number) => {
  try { return process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

type LockOwner = { pid?: number; token?: string };

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

function readOwner(dir: string): LockOwner | undefined {
  try { return JSON.parse(readFileSync(join(dir, "owner"), "utf8")) as LockOwner; }
  catch { return undefined; }
}

function placeLock(dir: string, owner: LockOwner): boolean {
  const partial = `${dir}.${owner.token}.partial`;
  mkdirSync(partial);
  writeFileSync(join(partial, "owner"), JSON.stringify(owner));
  try {
    renameSync(partial, dir);
    return true;
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY") return false;
    throw error;
  }
}

function releaseLock(dir: string, token: string): void {
  if (readOwner(dir)?.token === token) rmSync(dir, { recursive: true, force: true });
}

function isClaimed(dir: string, holder: LockOwner | undefined, context: JobContext): boolean | undefined {
  if (holder?.pid !== undefined) return (context.alive ?? isAlive)(holder.pid);
  const madeAt = statSync(dir, { throwIfNoEntry: false })?.mtimeMs;
  return madeAt === undefined ? undefined : context.now() - madeAt < unclaimedLockMs;
}

function takeLock(dir: string, context: JobContext): (() => void) | undefined {
  mkdirSync(dirname(dir), { recursive: true });
  const mine = { pid: context.pid ?? process.pid, token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (placeLock(dir, mine)) return () => releaseLock(dir, mine.token);
    const holder = readOwner(dir);
    const claimed = isClaimed(dir, holder, context);
    if (claimed) return undefined;
    if (claimed === undefined) continue;
    context.beforeTakeover?.();
    const aside = `${dir}.${mine.token}.stale`;
    try { renameSync(dir, aside); }
    catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (readOwner(aside)?.token !== holder?.token) {
      try { renameSync(aside, dir); }
      catch { rmSync(aside, { recursive: true, force: true }); }
      return undefined;
    }
    rmSync(aside, { recursive: true, force: true });
  }
  return undefined;
}

export async function underLock(context: JobContext, name: string, label: string, work: () => Promise<number>): Promise<number> {
  const release = takeLock(join(stateDir(context.home, context.env), `${name}.lock`), context);
  if (!release) {
    context.log(`Another ${label} runs, so this one ends.`);
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
    `start() { t3 thread start --title ${quote(title)} --provider ${quote(choice.provider)} --model ${quote(choice.model)} "$folder" - < "$prompt"; }`,
    `start || { t3 project add "$folder" >/dev/null && start; }`,
  ].join("\n");
}
