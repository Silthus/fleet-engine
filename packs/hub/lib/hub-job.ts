import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelFor } from "../../base/lib/models.ts";
import type { Env, Result } from "./coder.ts";
import { quote, readRole } from "./machine.ts";

export type JobContext = { home: string; env: Env; self: string; now(): number; log(line: string): void; pid?: number; alive?(pid: number): boolean };

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

function lockHolder(dir: string): number | undefined {
  try { return Number(readFileSync(join(dir, "pid"), "utf8")); }
  catch { return undefined; }
}

function takeLock(dir: string, context: JobContext): (() => void) | undefined {
  mkdirSync(dirname(dir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(context.pid ?? process.pid));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = lockHolder(dir);
    const claimed = holder === undefined ? context.now() - statSync(dir).mtimeMs < unclaimedLockMs : (context.alive ?? isAlive)(holder);
    if (claimed) return undefined;
    rmSync(dir, { recursive: true, force: true });
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

export function modelOr(role: string, fallback: string, env: Env): string {
  try { return modelFor(role, env).model; }
  catch { return fallback; }
}

const shellPath = (path: string) => (path === "~" ? `"$HOME"` : path.startsWith("~/") ? `"$HOME"/${quote(path.slice(2))}` : quote(path));

export function threadScript(folder: string, title: string, model: string): string {
  return [
    `prompt=$(mktemp) || exit 1`,
    `trap 'rm -f "$prompt"' EXIT`,
    `cat > "$prompt"`,
    `folder=${shellPath(folder)}`,
    `start() { t3 thread start --title ${quote(title)} --model ${quote(model)} "$folder" - < "$prompt"; }`,
    `start || { t3 project add "$folder" >/dev/null && start; }`,
  ].join("\n");
}
