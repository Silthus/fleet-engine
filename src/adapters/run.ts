import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AdapterResult } from "../reconciler/apply.ts";

/** clearEnv names variables the command must not inherit. */
/** inherit: the command uses this terminal, so its output is shown, not returned. */
/** signal: runs the command in its own process group, and ends the group when it aborts. */
export type RunOptions = { input?: string; home?: string; clearEnv?: string[]; inherit?: true; signal?: AbortSignal };
export type CommandRunner = (command: string[], options?: RunOptions) => Promise<{ code: number; stdout: string; stderr?: string }>;

export const spawnRunner: CommandRunner = async (command, options = {}) => {
  let started: { pid: number; kill(signal: NodeJS.Signals): void } | undefined;
  const endGroup = () => {
    if (started) try { process.kill(-started.pid, "SIGTERM"); } catch {}
  };
  const forward = (signal: NodeJS.Signals) => started?.kill(signal);
  const interrupted = (signal: NodeJS.Signals) => {
    endGroup();
    release();
    if (!process.listenerCount(signal)) process.kill(process.pid, signal);
  };
  const listener = options.inherit ? forward : options.signal ? interrupted : undefined;
  const release = () => void (listener && process.off("SIGINT", listener).off("SIGTERM", listener));
  if (listener) process.on("SIGINT", listener).on("SIGTERM", listener);
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
    if (options.signal) return await stoppable(endGroup, child.exited, output, options.signal);
    const [[stdout, stderr], code] = await Promise.all([output, child.exited]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: `${command[0]} could not start: ${error instanceof Error ? error.message : String(error)}\n` };
  } finally {
    release();
  }
};

/**
 * Runs a command that has its own process group until it exits or the signal aborts. An abort, or an interrupt
 * of this process that spawnRunner hears from before the command starts, ends the whole group, so a process it started, such as an ssh ProxyCommand, ends too. An
 * aborted command returns no output, since a process that left the group may keep the pipes open.
 */
async function stoppable(end: () => void, exited: Promise<number>, output: Promise<[string, string]>, signal: AbortSignal) {
  let settle: (value: [string, string]) => void = () => {};
  const stopped = new Promise<[string, string]>((done) => (settle = done));
  const stop = () => (end(), void exited.then(() => settle(["", ""])));
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const [[stdout, stderr], code] = await Promise.all([Promise.race([output, stopped]), exited]);
    return { code, stdout, stderr };
  } finally {
    signal.removeEventListener("abort", stop);
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

export type AccountSources = { platform: NodeJS.Platform; exists: (path: string) => boolean; file: (path: string) => string; output: (command: string[]) => Promise<string> };

async function output(command: string[]) {
  try {
    const child = Bun.spawn(command, { env: {}, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? text : "";
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

export async function accountHome(uid = process.getuid?.(), sources = system) {
  if (uid === undefined) return undefined;
  const fromPasswd = () => passwdHome(sources.file("/etc/passwd"), uid);
  if (sources.platform === "darwin") {
    const dscacheutil = "/usr/bin/dscacheutil";
    return (sources.exists(dscacheutil) ? directoryHome(await sources.output([dscacheutil, "-q", "user", "-a", "uid", String(uid)])) : undefined) ?? fromPasswd();
  }
  const getent = ["/usr/bin/getent", "/bin/getent"].find((path) => sources.exists(path));
  return (getent ? passwdHome(await sources.output([getent, "passwd", String(uid)]), uid) : undefined) ?? fromPasswd();
}

export type HomeGuard = { run?: CommandRunner; accountHome?: () => Promise<string | undefined> };

export async function skipOtherHome(adapter: string, what: string, home: string, options: HomeGuard): Promise<AdapterResult | undefined> {
  const lookup = options.accountHome ?? (options.run ? undefined : () => accountHome());
  if (!lookup) return undefined;
  const account = await lookup();
  if (account === undefined) {
    const say = `Fleet left ${what} alone: it could not look up your account's home folder, so it cannot tell whether ${home} is yours. Check that your system lists your user (getent passwd on Linux, dscacheutil on a Mac), then run fleet apply.`;
    return { actions: [], findings: [{ id: `${adapter}:home`, pack: "engine", say, repair: "human" }] };
  }
  return resolve(account) === resolve(home) ? undefined : { actions: [], findings: [] };
}
