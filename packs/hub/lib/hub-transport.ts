import { readFileSync } from "node:fs";
import { join } from "node:path";
import { optionalStringSetting } from "../../base/lib/settings.ts";
import { onHub } from "../../../src/hub/ssh.ts";

export class HubUnreachable extends Error {}

export type SshResult = { code: number; stdout: string; stderr: string };
export type Ssh = (host: string, command: string, stdin?: string, timeoutMs?: number) => Promise<SshResult>;
export type Env = Record<string, string | undefined>;

export const runSsh: Ssh = async (host, command, stdin, timeoutMs = 20_000) => {
  const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code: code ?? 255, stdout, stderr };
};

export function isHub(home: string) {
  try { return (JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8")) as { role?: unknown }).role === "hub"; }
  catch { return false; }
}

export function remoteHub(home: string, env: Env) {
  const hub = optionalStringSetting("hub.alias", env);
  return hub && !isHub(home) ? hub : undefined;
}

export const fleetOnHub = (hub: string, args: string[]) => onHub(hub, args).at(-1)!;

export const lastLine = (stderr: string) => stderr.trim().split("\n").at(-1);
