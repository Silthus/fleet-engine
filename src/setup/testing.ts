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
async function realGit(home: string, args: string[], cwd?: string): Promise<ExecResult> {
  const remotes = `${join(home, "github-remotes")}/`;
  const run = async (command: string[]) => {
    const child = Bun.spawn(command, { cwd, env: gitEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: `${stdout}${stderr}` };
  };
  const result = await run(["git", "-c", `url.${remotes}.insteadOf=https://github.com/`, ...args]);
  if (args[0] === "clone" && result.code === 0) await run(["git", "-C", args.at(-1)!, "config", `url.${remotes}.insteadOf`, "https://github.com/"]);
  return result;
}

type SignInName = "github" | "claude" | "chatgpt" | "coder" | "box:github" | "box:claude" | "box:chatgpt" | "box:t3" | "box:coder";

/** What coder whoami prints when signed in, as the Coder CLI writes it. */
export const coderWhoami = "Coder is running at https://coder.example.com, You're authenticated as nora !\n";
/** The one token coder tokens create prints, alone on its line. */
export const coderToken = ["fleet", "test", "coder", "token"].join("-");

/** The command an SSH call runs on the box, without the PATH prefix. */
export const onBox = (command: string[]) => (command[0] === "ssh" ? command.at(-1)!.replace(/^PATH=[^;]*; /, "") : undefined);

/**
 * A machine signed in to GitHub as nora, whose sign-ins pass after a number
 * of 2 s polls: 0 means already signed in, and a sign-in that is never
 * started never passes. Its gh makes repos as bare repos under the home, and
 * git runs for real with github.com rewritten to them. Its ssh reaches a fake
 * devbox whose sign-ins work the same way; Claude there signs in when its
 * foreground sign-in runs.
 */
export function fakeMachine(home: string, polls: Partial<Record<SignInName, number>> = {}, options: { org?: boolean; scopes?: string; failRun?: boolean; exits?: Partial<Record<SignInName, number>>; connectHere?: boolean; boxFiles?: Record<string, string>; hubDown?: boolean } = {}) {
  const left: Record<SignInName, number> = { github: 0, claude: 0, chatgpt: 0, coder: 0, "box:github": 0, "box:claude": 0, "box:chatgpt": 0, "box:t3": 0, "box:coder": 0, ...polls };
  const started = new Set<SignInName>();
  const calls: Array<{ command: string[]; cwd?: string; timeoutMs?: number; input?: string }> = [];
  const coderSsh: string[] = [];
  const hubUpdates: string[] = [];
  const starts: string[][] = [];
  const runs: Array<{ command: string[]; input: boolean }> = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  let devbox = false;
  const passes = (name: SignInName) => left[name] === 0;
  const result = (ok: boolean, output = ""): ExecResult => ({ code: ok ? 0 : 1, output });
  const ghStatus = (name: SignInName, granted: string) => (passes(name) ? result(true, `github.com\n${granted}\n`) : result(false, "You are not logged in"));
  const t3 = (line: string, token: string) => {
    if (line.startsWith("t3 pair ")) return result(true, `Pairing with test.\n\nPairing URL: http://127.0.0.1:3773/pair#token=x\nToken: ${token}\n`);
    if (line.startsWith("t3 environment link ")) return result(true, "linked");
    return undefined;
  };
  const box = (line: string, input?: string, host?: string): ExecResult => {
    if (line.endsWith('/.local/share/fleet/engine/fleet" update')) return hubUpdates.push(host ?? ""), result(!options.hubDown, options.hubDown ? "ssh: connect to host: Connection refused" : "✓ Up to date");
    if (line === "coder whoami") return passes("box:coder") ? result(true, coderWhoami) : result(false, "You are not logged in");
    if (line.includes("coder login https://coder.example.com") && line.startsWith("sh -c ")) {
      if (input === `${coderToken}\n`) left["box:coder"] = 0;
      return result(passes("box:coder"), passes("box:coder") ? "Welcome to Coder, nora! You're authenticated." : "invalid token");
    }
    if (line === "coder config-ssh --yes") return passes("box:coder") ? (coderSsh.push("box"), result(true, "Updated \"~/.ssh/config\"")) : result(false, "You are not logged in");
    if (line.startsWith("gh auth status")) return ghStatus("box:github", scopes);
    if (line === "gh auth setup-git") return result(true);
    if (line === "claude auth status") return result(passes("box:claude"), JSON.stringify({ loggedIn: passes("box:claude") }));
    if (line.includes("codex exec")) return result(passes("box:chatgpt"), "ok");
    if (line.startsWith("sh -c 'if [ -f ")) return result(true, Object.entries(options.boxFiles ?? {}).map(([path, text]) => `=== file ${path}\n${text}\n`).join(""));
    if (line === "t3 connect status --json") return result(true, JSON.stringify({ authenticated: passes("box:t3"), linked: passes("box:t3"), relayUrl: passes("box:t3") ? "https://box-1.relay.example/" : null }));
    return t3(line, "BOXCODE") ?? result(false, `unexpected on the box: ${line}`);
  };
  const machine: Machine = {
    async exec(command, run = {}) {
      calls.push({ command, ...run });
      const remote = onBox(command);
      if (remote !== undefined) return box(remote, run.input, command.at(-2));
      const line = command.join(" ");
      if (line.startsWith("gh auth status")) return ghStatus("github", started.has("github") ? scopes : (options.scopes ?? scopes));
      if (line === "gh auth setup-git") return result(true);
      if (line.startsWith("gh api user/memberships/orgs/")) return options.org ? result(true, "active\n") : result(false, "Not Found");
      if (line === "claude auth status") return result(passes("claude"), JSON.stringify({ loggedIn: passes("claude") }));
      if (line.startsWith("codex exec")) return result(passes("chatgpt"), "ok");
      if (line === "coder whoami") return passes("coder") ? result(true, coderWhoami) : result(false, "You are not logged in");
      if (line === "coder tokens create") return passes("coder") ? result(true, `${coderToken}\n`) : result(false, "You are not logged in");
      if (line === "hogli devbox:status") return result(devbox);
      if (line === "hogli devbox:start") return (devbox = true), result(true, "up");
      if (line === "gh api user --jq .login") return result(true, "nora\n");
      if (line.startsWith("gh repo view ")) return result(existsSync(githubRepo(home, command[3]!)), "");
      if (line.startsWith("gh repo create ")) {
        const bare = githubRepo(home, command[3]!);
        mkdirSync(bare, { recursive: true });
        return realGit(home, ["init", "-q", "--bare", "-b", "main", bare]);
      }
      if (command[0] === "git") return realGit(home, command.slice(1), run.cwd);
      if (line === "t3 connect status --json") return result(true, JSON.stringify({ authenticated: Boolean(options.connectHere), linked: Boolean(options.connectHere), relayUrl: options.connectHere ? "https://here.relay.example/" : null }));
      return t3(line, "HERECODE") ?? result(false, `unexpected ${line}`);
    },
    start(command) {
      starts.push(command);
      const remote = onBox(command);
      const word = (remote ?? command.join(" ")).split(" ")[0];
      const name = word === "gh" ? "github" : word === "claude" ? "claude" : word === "codex" ? "chatgpt" : word === "t3" ? "t3" : "coder";
      const signIn = (remote === undefined ? name : `box:${name}`) as SignInName;
      started.add(signIn);
      const exit = options.exits?.[signIn];
      if (exit !== undefined) return { stop: () => {}, exited: Promise.resolve(exit) };
      let kill = () => {};
      return { stop: () => kill(), exited: new Promise<number>((resolve) => (kill = () => resolve(143))) };
    },
    async run(command, run = {}) {
      runs.push({ command, input: run.input ?? false });
      if (onBox(command) === "claude auth login") left["box:claude"] = 0;
      if (options.failRun) return 1;
      if (command.join(" ") === "sh -c coder login") left.coder = 0;
      return 0;
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
  return { machine, calls, starts, runs, sleeps, opened, coderSsh, hubUpdates };
}

export async function fleetSetup(home: string, args: string[], replies: string[] = [], box = fakeMachine(home), fetchSource?: (ref: SourceRef, cache: string) => Promise<FetchedSource>, doctorCode = 0, platform: NodeJS.Platform = "linux", onApply: (dir: string) => void = () => {}) {
  const io = scripted(replies);
  const applied: string[] = [];
  const doctored: string[] = [];
  const apply = async (dir: string) => (applied.push(dir), onApply(dir), 0);
  const doctor = async (dir: string) => (doctored.push(dir), doctorCode);
  const code = await main(["setup", ...args], { home, engineRoot, platform, print: io.terminal.print, terminal: io.terminal, apply, setup: { machine: box.machine, doctor, env: {}, timeZone: "UTC", ...(fetchSource ? { fetchSource } : {}) } });
  return { code, prompts: io.prompts, output: io.output(), applied, doctored };
}

export const machineFile = (home: string) => JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8"));

/** The answers in the profile clone on this machine. */
export const savedAnswers = (home: string) => JSON.parse(readFileSync(join(profilePath(home), "fleet.json"), "utf8"));

/** The answers as pushed to the fake github.com. */
export async function pushedAnswers(home: string, repo = "nora/fleet-profile") {
  return JSON.parse((await realGit(home, ["--git-dir", githubRepo(home, repo), "show", "main:fleet.json"])).output);
}
