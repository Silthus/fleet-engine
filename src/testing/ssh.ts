import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../adapters/run.ts";
import { main, type CliOptions } from "../cli.ts";

export type Answer = { code: number; stdout: string; stderr: string };
export type Host = (args: string[]) => Promise<Answer>;

/** A fleet on another machine: its main, with what it prints as standard output and what it fails with as standard error. */
export function remoteFleet(options: () => CliOptions): Host {
  return async (args) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { ...options(), print: (line) => out.push(line), fail: (line) => err.push(line) });
    return { code, stdout: out.map((line) => `${line}\n`).join(""), stderr: err.map((line) => `${line}\n`).join("") };
  };
}

/** ssh that runs its remote line in a real login shell, sh unless named, in an empty home whose fleet launcher hands its words to the named host's fleet. A host that is down, or not named, answers as ssh does, and an aborted signal ends the call as a killed ssh. */
export function fakeSsh(home: string, hosts: Record<string, Host | "down">, shell = "sh"): CommandRunner {
  mkdirSync(join(home, ".local/share/fleet/engine"), { recursive: true });
  writeFileSync(join(home, ".local/share/fleet/engine/fleet"), `printf '%s\\0' "$@"\n`);
  return async (command, options = {}) => {
    if (command[0] !== "ssh" || !command.includes("BatchMode=yes")) return { code: 127, stdout: "", stderr: `${command[0]}: not ssh in batch mode\n` };
    const host = command.at(-2)!;
    const line = command.at(-1)!;
    const target = hosts[host];
    if (!target || target === "down") return { code: 255, stdout: "", stderr: `ssh: connect to host ${host} port 22: Connection refused\n` };
    const login = Bun.spawnSync([shell, "-c", line], { cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" } });
    if (login.exitCode !== 0) return { code: login.exitCode, stdout: "", stderr: login.stderr.toString() };
    const answer = target(login.stdout.toString().split("\0").slice(0, -1));
    const { signal } = options;
    if (!signal) return answer;
    const killed = new Promise<Answer>((settle) => signal.addEventListener("abort", () => settle({ code: 143, stdout: "", stderr: "" }), { once: true }));
    return Promise.race([answer, killed]);
  };
}
