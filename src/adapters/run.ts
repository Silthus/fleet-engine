import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AdapterResult } from "../reconciler/apply.ts";

export type RunOptions = { input?: string; home?: string };
export type CommandRunner = (command: string[], options?: RunOptions) => Promise<{ code: number; stdout: string; stderr?: string }>;

export const spawnRunner: CommandRunner = async (command, options = {}) => {
  try {
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
      env: options.home === undefined ? Bun.env : { ...Bun.env, HOME: options.home },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } catch {
    return { code: 127, stdout: "" };
  }
};

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

function output(command: string[]) {
  if (!existsSync(command[0]!)) return "";
  try {
    const child = Bun.spawnSync(command, { env: {}, stdin: "ignore" });
    return child.exitCode === 0 ? child.stdout.toString() : "";
  } catch {
    return "";
  }
}

function passwdFile() {
  try {
    return readFileSync("/etc/passwd", "utf8");
  } catch {
    return "";
  }
}

export function accountHome(uid = process.getuid?.()) {
  if (uid === undefined) return undefined;
  if (process.platform === "darwin") return directoryHome(output(["/usr/bin/dscacheutil", "-q", "user", "-a", "uid", String(uid)])) ?? passwdHome(passwdFile(), uid);
  const getent = ["/usr/bin/getent", "/bin/getent"].find((path) => existsSync(path));
  return (getent ? passwdHome(output([getent, "passwd", String(uid)]), uid) : undefined) ?? passwdHome(passwdFile(), uid);
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
