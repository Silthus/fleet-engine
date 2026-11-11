import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AdapterResult } from "../reconciler/apply.ts";

/** clearEnv names variables the command must not inherit. */
/** inherit: the command uses this terminal, so its output is shown, not returned. */
/** signal: runs the command in its own process group, and ends the group when it aborts. */
export type RunOptions = { input?: string; home?: string; clearEnv?: string[]; inherit?: true; signal?: AbortSignal };
export type CommandRunner = (command: string[], options?: RunOptions) => Promise<{ code: number; stdout: string; stderr?: string }>;

export const spawnRunner: CommandRunner = async (command, options = {}) => {
  let started: { kill(signal: NodeJS.Signals): void } | undefined;
  const forward = (signal: NodeJS.Signals) => started?.kill(signal);
  if (options.inherit) process.on("SIGINT", forward).on("SIGTERM", forward);
  try {
    const child = Bun.spawn(command, {
      stdout: options.inherit ? "inherit" : "pipe",
      stderr: options.inherit ? "inherit" : "pipe",
      stdin: options.inherit ? "inherit" : options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
      env: Object.fromEntries(Object.entries({ ...Bun.env, ...(options.home === undefined ? {} : { HOME: options.home }) }).filter(([name]) => !options.clearEnv?.includes(name))),
      ...(options.signal ? { detached: true } : {}),
    });
    started = child;
    if (options.inherit) return { code: await child.exited, stdout: "" };
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (options.signal) return await stoppable(child.pid, child.exited, output, options.signal);
    const [[stdout, stderr], code] = await Promise.all([output, child.exited]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: `${command[0]} could not start: ${error instanceof Error ? error.message : String(error)}\n` };
  } finally {
    process.off("SIGINT", forward).off("SIGTERM", forward);
  }
};

/**
 * Runs a command that has its own process group until it exits or the signal aborts. An abort, or an interrupt
 * of this process, ends the whole group, so a process it started, such as an ssh ProxyCommand, ends too. An
 * aborted command returns no output, since a process that left the group may keep the pipes open.
 */
async function stoppable(group: number, exited: Promise<number>, output: Promise<[string, string]>, signal: AbortSignal) {
  const end = () => {
    try { process.kill(-group, "SIGTERM"); } catch {}
  };
  let settle: (value: [string, string]) => void = () => {};
  const stopped = new Promise<[string, string]>((done) => (settle = done));
  const stop = () => (end(), void exited.then(() => settle(["", ""])));
  const interrupted = (name: NodeJS.Signals) => {
    end();
    release();
    if (!process.listenerCount(name)) process.kill(process.pid, name);
  };
  const release = () => {
    signal.removeEventListener("abort", stop);
    process.off("SIGINT", interrupted).off("SIGTERM", interrupted);
  };
  signal.addEventListener("abort", stop, { once: true });
  process.on("SIGINT", interrupted).on("SIGTERM", interrupted);
  if (signal.aborted) stop();
  try {
    const [[stdout, stderr], code] = await Promise.all([Promise.race([output, stopped]), exited]);
    return { code, stdout, stderr };
  } finally {
    release();
  }
}

export function passwdHome(text: string, uid: number) {
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields.length >= 7 && fields[2] === String(uid) && fields[5]!.startsWith("/")) return fields[5];
  }
  return undefined;
}

export function directoryHome(text: string) {
  const home = text.split("\n").find((line) => line.startsWith("dir:"))?.slice(4).trim();
  return home?.startsWith("/") ? home : undefined;
}

export type AccountSources = { platform: NodeJS.Platform; exists: (path: string) => boolean; file: (path: string) => string; output: (command: string[]) => string };

function output(command: string[]) {
  try {
    const child = Bun.spawnSync(command, { env: {}, stdin: "ignore" });
    return child.exitCode === 0 ? child.stdout.toString() : "";
  } catch {
    return "";
  }
}

function file(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const system: AccountSources = { platform: process.platform, exists: existsSync, file, output };

export function accountHome(uid = process.getuid?.(), sources = system) {
  if (uid === undefined) return undefined;
  const fromPasswd = () => passwdHome(sources.file("/etc/passwd"), uid);
  if (sources.platform === "darwin") {
    const dscacheutil = "/usr/bin/dscacheutil";
    return (sources.exists(dscacheutil) ? directoryHome(sources.output([dscacheutil, "-q", "user", "-a", "uid", String(uid)])) : undefined) ?? fromPasswd();
  }
  const getent = ["/usr/bin/getent", "/bin/getent"].find((path) => sources.exists(path));
  return (getent ? passwdHome(sources.output([getent, "passwd", String(uid)]), uid) : undefined) ?? fromPasswd();
}

export type HomeGuard = { run?: CommandRunner; accountHome?: () => string | undefined };

export function skipOtherHome(adapter: string, what: string, home: string, options: HomeGuard): AdapterResult | undefined {
  const lookup = options.accountHome ?? (options.run ? undefined : accountHome);
  if (!lookup) return undefined;
  const account = lookup();
  if (account === undefined) {
    const say = `Fleet left ${what} alone: it could not look up your account's home folder, so it cannot tell whether ${home} is yours. Check that your system lists your user (getent passwd on Linux, dscacheutil on a Mac), then run fleet apply.`;
    return { actions: [], findings: [{ id: `${adapter}:home`, pack: "engine", say, repair: "human" }] };
  }
  return resolve(account) === resolve(home) ? undefined : { actions: [], findings: [] };
}
