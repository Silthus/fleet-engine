import { capture, type Capture } from "./coder.ts";
import { shellLimitMs } from "./machine.ts";
import { gatewayPort } from "./mcphub/client.ts";
import type { Run } from "./mcphub/hub.ts";

const runtimeDir = () => Bun.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;

export const runWith = (spawn: Capture): Run => (command, options = {}) =>
  spawn(command, { env: { ...Bun.env, XDG_RUNTIME_DIR: runtimeDir() }, ...(options.input === undefined ? {} : { stdin: options.input }), timeoutMs: options.timeoutMs ?? shellLimitMs });

export const run = runWith(capture);

export async function must(run: Run, command: string[], input?: string): Promise<string> {
  const result = await run(command, input === undefined ? {} : { input });
  if (result.code !== 0) throw new Error(`${command.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

export const hostPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export const proxyPort = 8317;

export function relayPortOf(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === gatewayPort || port === proxyPort) throw new Error(`hub.relayPort must be a port from 1024 to 65535 other than ${gatewayPort} and ${proxyPort}, not ${port}.`);
  return port;
}
