import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import type { ExecResult, Machine } from "./commands.ts";
import { Stopped, type Terminal } from "./terminal.ts";

export const engineRoot = join(import.meta.dir, "../..");

/** Types each reply in turn; when the replies run out it acts like Ctrl-C. */
export function scripted(replies: string[]) {
  const lines: string[] = [];
  const prompts: string[] = [];
  const terminal: Terminal = {
    print: (line) => void lines.push(line),
    async ask(prompt) {
      prompts.push(prompt);
      const reply = replies.shift();
      if (reply === undefined) throw new Stopped();
      lines.push(`${prompt}${reply}`);
      return reply;
    },
  };
  return { terminal, prompts, output: () => lines.join("\n") };
}

const scopes = "  - Token scopes: 'admin:public_key', 'admin:ssh_signing_key', 'read:org', 'repo'";

/**
 * A machine whose sign-ins pass after a number of 2 s polls: 0 means already
 * signed in, and a sign-in that is never started never passes.
 */
export function fakeMachine(polls: Partial<Record<"github" | "claude" | "chatgpt" | "coder", number>> = {}, options: { org?: boolean; scopes?: string; exits?: Partial<Record<"github" | "claude" | "chatgpt" | "coder", number>> } = {}) {
  const left = { github: 0, claude: 0, chatgpt: 0, coder: 0, ...polls };
  const started = new Set<keyof typeof left>();
  const calls: Array<{ command: string[]; cwd?: string; timeoutMs?: number }> = [];
  const starts: string[][] = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  let devbox = false;
  const passes = (name: keyof typeof left) => left[name] === 0;
  const result = (ok: boolean, output = ""): ExecResult => ({ code: ok ? 0 : 1, output });
  const machine: Machine = {
    async exec(command, run = {}) {
      calls.push({ command, ...run });
      const line = command.join(" ");
      if (line.startsWith("gh auth status")) return passes("github") ? result(true, `github.com\n${started.has("github") ? scopes : (options.scopes ?? scopes)}\n`) : result(false, "You are not logged in");
      if (line === "gh auth setup-git") return result(true);
      if (line.startsWith("gh api user/memberships/orgs/")) return options.org ? result(true, "active\n") : result(false, "Not Found");
      if (line === "claude auth status") return result(passes("claude"), JSON.stringify({ loggedIn: passes("claude") }));
      if (line.startsWith("codex exec")) return result(passes("chatgpt"), "ok");
      if (line === "coder whoami") return result(passes("coder"), "nora");
      if (line === "hogli devbox:status") return result(devbox);
      if (line === "hogli devbox:start") return (devbox = true), result(true, "up");
      return result(false, `unexpected ${line}`);
    },
    start(command) {
      starts.push(command);
      const name = command[0] === "gh" ? "github" : command[0] === "claude" ? "claude" : command[0] === "codex" ? "chatgpt" : "coder";
      started.add(name);
      const exit = options.exits?.[name];
      return { stop: () => {}, exited: exit === undefined ? new Promise<number>(() => {}) : Promise.resolve(exit) };
    },
    async sleep(ms) {
      sleeps.push(ms);
      for (const name of started) if (left[name] > 0) left[name]--;
    },
    async openUrl(url) {
      opened.push(url);
    },
    has: () => true,
  };
  return { machine, calls, starts, sleeps, opened };
}

export async function fleetSetup(home: string, args: string[], replies: string[] = [], box = fakeMachine(), fetchSource?: (ref: SourceRef, cache: string) => Promise<FetchedSource>) {
  const io = scripted(replies);
  const code = await main(["setup", ...args], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, setup: { machine: box.machine, ...(fetchSource ? { fetchSource } : {}) } });
  return { code, prompts: io.prompts, output: io.output() };
}

export const machineFile = (home: string) => JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8"));
