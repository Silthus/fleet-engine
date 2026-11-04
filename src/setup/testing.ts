import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import type { ExecResult, Machine } from "./commands.ts";
import { gitEnv } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
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

/** The bare repo that stands in for github.com/<repo> under a test home. */
export const githubRepo = (home: string, repo: string) => join(home, "github-remotes", `${repo}.git`);

/** Git with github.com rewritten to the bare repos; a clone keeps the rewrite, so later pushes from any code reach them too. */
function realGit(home: string, args: string[], cwd?: string): ExecResult {
  const remotes = `${join(home, "github-remotes")}/`;
  const child = Bun.spawnSync(["git", "-c", `url.${remotes}.insteadOf=https://github.com/`, ...args], { cwd, env: gitEnv });
  if (args[0] === "clone" && child.exitCode === 0) Bun.spawnSync(["git", "-C", args.at(-1)!, "config", `url.${remotes}.insteadOf`, "https://github.com/"], { env: gitEnv });
  return { code: child.exitCode ?? 1, output: `${child.stdout.toString()}${child.stderr.toString()}` };
}

/**
 * A machine signed in to GitHub as nora, whose sign-ins pass after a number
 * of 2 s polls: 0 means already signed in, and a sign-in that is never
 * started never passes. Its gh makes repos as bare repos under the home, and
 * git runs for real with github.com rewritten to them.
 */
export function fakeMachine(home: string, polls: Partial<Record<"github" | "claude" | "chatgpt" | "coder", number>> = {}, options: { org?: boolean; scopes?: string; failApply?: boolean } = {}) {
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
      if (line.startsWith("gh api user/memberships/orgs/")) return options.org ? result(true, "active\n") : result(false, "Not Found");
      if (line === "claude auth status") return result(passes("claude"), JSON.stringify({ loggedIn: passes("claude") }));
      if (line.startsWith("codex exec")) return result(passes("chatgpt"), "ok");
      if (line === "coder whoami") return result(passes("coder"), "nora");
      if (line === "hogli devbox:status") return result(devbox);
      if (line === "hogli devbox:start") return (devbox = true), result(true, "up");
      if (line === "gh api user --jq .login") return result(true, "nora\n");
      if (line === "gh auth setup-git") return result(true);
      if (line.startsWith("gh repo view ")) return result(existsSync(githubRepo(home, command[3]!)), "");
      if (line.startsWith("gh repo create ")) {
        const bare = githubRepo(home, command[3]!);
        mkdirSync(bare, { recursive: true });
        return realGit(home, ["init", "-q", "--bare", "-b", "main", bare]);
      }
      if (command[0] === "git") return realGit(home, command.slice(1), run.cwd);
      return result(false, `unexpected ${line}`);
    },
    start(command) {
      starts.push(command);
      const name = command[0] === "gh" ? "github" : command[0] === "claude" ? "claude" : command[0] === "codex" ? "chatgpt" : "coder";
      started.add(name);
      return { stop: () => {} };
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

export async function fleetSetup(home: string, args: string[], replies: string[] = [], box = fakeMachine(home), fetchSource?: (ref: SourceRef, cache: string) => Promise<FetchedSource>) {
  const io = scripted(replies);
  const applied: string[] = [];
  const apply = async (dir: string) => (applied.push(dir), 0);
  const code = await main(["setup", ...args], { home, engineRoot, platform: "linux", print: io.terminal.print, terminal: io.terminal, apply, setup: { machine: box.machine, ...(fetchSource ? { fetchSource } : {}) } });
  return { code, prompts: io.prompts, output: io.output(), applied };
}

export const machineFile = (home: string) => JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8"));

/** The answers in the profile clone on this machine. */
export const savedAnswers = (home: string) => JSON.parse(readFileSync(join(profilePath(home), "fleet.json"), "utf8"));

/** The answers as pushed to the fake github.com. */
export function pushedAnswers(home: string, repo = "nora/fleet-profile") {
  return JSON.parse(realGit(home, ["--git-dir", githubRepo(home, repo), "show", "main:fleet.json"]).output);
}
