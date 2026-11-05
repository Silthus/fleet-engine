import type { Run } from "./mcphub/hub.ts";

const runtimeDir = () => Bun.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;

export const run: Run = async (command, options = {}) => {
  const child = Bun.spawn(command, { cwd: options.cwd, env: { ...Bun.env, XDG_RUNTIME_DIR: runtimeDir() }, stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};

export async function must(run: Run, command: string[], input?: string): Promise<string> {
  const result = await run(command, input === undefined ? {} : { input });
  if (result.code !== 0) throw new Error(`${command.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

export const hostPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const aliasPattern = /^[a-z0-9][a-z0-9.-]*$/;
export const gatewayPort = 3317;

export function relayPortOf(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === gatewayPort) throw new Error(`hub.relayPort must be a port from 1024 to 65535 other than ${gatewayPort}, not ${port}.`);
  return port;
}

export function sshName(alias: string): string {
  if (!aliasPattern.test(alias)) throw new Error(`${JSON.stringify(alias)} is not an SSH name Fleet can use.`);
  return alias;
}
