import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

export type T3ServerCommand = { command: string; args: string[] };
export type T3Server = { origin: string; wsUrl: string; cli: T3ServerCommand };
export type T3CliResult = { status: number | null; stdout: string; stderr?: string; error?: string };
export type SpawnT3Cli = (command: string, args: string[], options: { encoding: "utf8"; env: NodeJS.ProcessEnv; timeout: number }) => {
  status: number | null; stdout: string; stderr: string; signal?: string | null; error?: Error & { code?: string };
};
export type RunT3Cli = (server: T3Server, args: string[]) => T3CliResult;

const scriptArg = /^(\/.*?\.[cm]?js)(?:\s|$)/;
const orchestrationProtocol = "2";

export function t3AuthHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": orchestrationProtocol };
}

export function t3WsUrl(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}/ws?orchestrationProtocol=${orchestrationProtocol}`;
}

export function t3UserData(home: string = homedir()): string {
  return join(home, ".t3", "userdata");
}

export function discoverT3Server(home: string = homedir()): T3Server {
  const userdata = t3UserData(home);
  const runtimePath = join(userdata, "server-runtime.json");
  if (!existsSync(runtimePath)) throw new Error(`T3 is not running on this machine: no server-runtime.json in ${userdata}. Start T3 Code, then try again.`);
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as { pid: number; origin: string };
  const cli = serverCommand(runtime.pid);
  if (!cli) throw new Error(`T3 is not running on this machine: its server process ${runtime.pid} has ended. Start T3 Code, then try again.`);
  return { origin: runtime.origin, wsUrl: t3WsUrl(runtime.origin), cli };
}

function serverCommand(pid: number): T3ServerCommand | undefined {
  return platform === "darwin" ? darwinServerCommand(pid) : linuxServerCommand(pid);
}

function linuxServerCommand(pid: number): T3ServerCommand | undefined {
  try {
    const command = readlinkSync(`/proc/${pid}/exe`);
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return { command, args: scriptArgs(argv[1] ?? "") };
  } catch {
    return undefined;
  }
}

function darwinServerCommand(pid: number): T3ServerCommand | undefined {
  const comm = ps(pid, "comm");
  const args = ps(pid, "args");
  if (!comm || args === undefined) return undefined;
  return parseDarwinCommand(comm, args);
}

function ps(pid: number, column: "comm" | "args"): string | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", `${column}=`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function parseDarwinCommand(comm: string, args: string): T3ServerCommand {
  const rest = args.startsWith(comm) ? args.slice(comm.length).trim() : "";
  const bundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(comm)?.[1];
  if (bundle) {
    const script = `${bundle}/Contents/Resources/app.asar/apps/server/dist/bin.mjs`;
    if (!(` ${rest} `).includes(` ${script} `)) throw new Error("Cannot identify the T3 desktop server script");
    return { command: comm, args: [script] };
  }
  return { command: comm, args: scriptArgs(rest) };
}

function scriptArgs(candidate: string): string[] {
  const match = scriptArg.exec(candidate);
  return match ? [match[1]!] : [];
}

const defaultCliTimeoutMs = 10_000;

export function t3CliRunner({ timeoutMs = defaultCliTimeoutMs, spawn = spawnSync as SpawnT3Cli }: { timeoutMs?: number; spawn?: SpawnT3Cli } = {}): RunT3Cli {
  return (server, argv) => {
    const { command, args } = server.cli;
    const env = args.length ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
    const result = spawn(command, [...args, ...argv], { encoding: "utf8", env, timeout: timeoutMs });
    const error = result.error?.code === "ETIMEDOUT" ? `timed out after ${timeoutMs} ms`
      : result.error?.message ?? (result.status === null && result.signal ? `ended by ${result.signal}` : undefined);
    return { status: result.status, stdout: result.stdout ?? "", ...(result.stderr ? { stderr: result.stderr } : {}), ...(error ? { error } : {}) };
  };
}

export const runT3Cli: RunT3Cli = t3CliRunner();

export function t3CliFailure(result: T3CliResult): string {
  if (result.error) return result.error;
  const stderr = result.stderr?.trim();
  return `exit ${result.status}${stderr ? `: ${stderr}` : ""}`;
}
