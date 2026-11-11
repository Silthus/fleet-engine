import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import type { ExecResult, Machine } from "./commands.ts";
import { quote } from "../hub/ssh.ts";
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
    return { code, output: `${stdout}${stderr}`, stdout };
  };
  const rewrite = `url.${remotes}.insteadOf=https://github.com/`;
  return run(["git", "-c", rewrite, ...(args[0] === "clone" ? ["clone", "--config", rewrite, ...args.slice(1)] : args)]);
}

type T3Session = { sessionId: string; token: string; revoked: boolean };

type SignInName = "github" | "claude" | "chatgpt" | "coder" | "box:github" | "box:claude" | "box:chatgpt" | "box:t3" | "box:coder";

/** What coder whoami prints when signed in, as the Coder CLI writes it. */
export const coderWhoami = "Coder is running at https://coder.example.com, You're authenticated as nora !\n";
/** The one token coder tokens create prints, alone on its line. */
export const coderToken = ["fleet", "test", "coder", "token"].join("-");

const hostKeyAdded = (host: string) => `Warning: Permanently added '${host}' (ED25519) to the list of known hosts.\n`;

export const boxHome = (home: string, host: string) => join(home, "boxes", host);

export const boxMachineFile = (home: string, host: string) => JSON.parse(readFileSync(join(boxHome(home, host), ".config/fleet/machine.json"), "utf8"));

/** The command an SSH call runs on the box, without the PATH prefix. */
export const onBox = (command: string[]) => (command[0] === "ssh" ? command.at(-1)!.replace(/^PATH=[^;]*; /, "") : undefined);

/**
 * A machine signed in to GitHub as nora, whose sign-ins pass after a number
 * of 2 s polls: 0 means already signed in, and a sign-in that is never
 * started never passes. Its gh makes repos as bare repos under the home,
 * except in the org named by createFails, and
 * git runs for real with github.com rewritten to them. Its ssh reaches a fake
 * devbox whose sign-ins work the same way, and which, like real ssh, warns
 * on stderr that it added the host key the first time it reaches a host
 * other than a coder. one; Claude there signs in when its
 * foreground sign-in runs. A command on the box that reads or writes its
 * role file runs for real in a home folder of its own under the test home.
 * The hub takes the nodes the pushed profile lists at each fleet update;
 * until then it refuses a node's credential when the node applies its
 * profile, and its fleet peers link refuses the node.
 * T3 on each machine reports what the real CLI prints: the shared relayUrl,
 * and a tunnelHostname only when cliPrintsTunnel is set. Its server answers
 * link-state with the tunnel hostname to a session it issued and has not
 * revoked, unless serverWithoutLinkState is set.
 */
export function fakeMachine(home: string, polls: Partial<Record<SignInName, number>> = {}, options: { org?: boolean; createFails?: string; scopes?: string; failRun?: boolean; exits?: Partial<Record<SignInName, number>>; connectHere?: boolean; cliPrintsTunnel?: boolean; serverWithoutLinkState?: boolean; boxFiles?: Record<string, string>; hubDown?: boolean; hubUpdateFails?: string; boxCoderAt?: string } = {}) {
  const left: Record<SignInName, number> = { github: 0, claude: 0, chatgpt: 0, coder: 0, "box:github": 0, "box:claude": 0, "box:chatgpt": 0, "box:t3": 0, "box:coder": 0, ...polls };
  const started = new Set<SignInName>();
  const calls: Array<{ command: string[]; cwd?: string; timeoutMs?: number; input?: string }> = [];
  const coderSsh: string[] = [];
  const hubUpdates: string[] = [];
  const hubTook = new Set<string>();
  const credentials: Array<{ node: string; issued: boolean }> = [];
  const hubLinked: string[] = [];
  const starts: string[][] = [];
  const runs: Array<{ command: string[]; input: boolean }> = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  let devbox = false;
  const passes = (name: SignInName) => left[name] === 0;
  const result = (ok: boolean, output = ""): ExecResult => ({ code: ok ? 0 : 1, output, stdout: output });
  const reached = new Set<string>();
  const ghStatus = (name: SignInName, granted: string) => (passes(name) ? result(true, `github.com\n${granted}\n`) : result(false, "You are not logged in"));
  const boxSessions: T3Session[] = [];
  const hereSessions: T3Session[] = [];
  const t3 = (line: string, token: string, input: string | undefined, side: { linked: boolean; tunnel: string; sessions: T3Session[] }) => {
    const { sessions } = side;
    if (line.startsWith("t3 pair ")) return result(true, `Pairing with test.\n\nPairing URL: http://127.0.0.1:3773/pair#token=x\nToken: ${token}\n`);
    if (line.startsWith("t3 environment link ")) return result(true, "linked");
    if (line === "t3 connect status --json") return result(true, JSON.stringify({ desired: side.linked, authenticated: side.linked, linked: side.linked, revoked: false, relayUrl: "https://relay.example", ...(options.cliPrintsTunnel && side.linked ? { tunnelHostname: side.tunnel } : {}) }));
    if (line === `sh -c 'cat "$HOME/.t3/userdata/server-runtime.json"'`) return result(true, JSON.stringify({ version: 1, pid: 4242, port: 3773, origin: "http://127.0.0.1:3773" }));
    if (line === "t3 auth session issue --json --ttl 5m --label fleet --subject fleet --scope relay:read") {
      const session = { sessionId: `session-${sessions.length + 1}`, token: `t3-bearer-${side.tunnel}-${sessions.length + 1}`, revoked: false };
      sessions.push(session);
      return result(true, `${JSON.stringify({ sessionId: session.sessionId, token: session.token, scopes: ["relay:read"] })}\n`);
    }
    const revoked = sessions.find((session) => line === `t3 auth session revoke ${session.sessionId}`);
    if (revoked) return (revoked.revoked = true), result(true, "Revoked.");
    if (line === "curl -fsS --max-time 15 -H @- http://127.0.0.1:3773/api/connect/link-state") {
      const live = sessions.some((session) => !session.revoked && input?.split("\n").includes(`authorization: Bearer ${session.token}`));
      if (!live) return { code: 22, output: "curl: (22) The requested URL returned error: 401", stdout: "" };
      if (options.serverWithoutLinkState) return { code: 22, output: "curl: (22) The requested URL returned error: 404", stdout: "" };
      return result(true, JSON.stringify({ linked: side.linked, relayUrl: "https://relay.example", managedTunnelActive: side.linked, linkRevoked: false, tunnelHostname: side.linked ? side.tunnel : null, linkableHere: false }));
    }
    return undefined;
  };
  const pushedProfile = async (): Promise<{ hub?: string; devboxes?: string[] }> => {
    try {
      return await pushedAnswers(home);
    } catch {
      return {};
    }
  };
  const onTheHub = async (line: string, host: string): Promise<ExecResult | undefined> => {
    const fleet = line.match(/\/\.local\/share\/fleet\/engine\/fleet" (.+)$/)?.[1];
    if (fleet === undefined) return undefined;
    if (options.hubDown) return { code: 255, output: "ssh: connect to host: Connection refused", stdout: "" };
    if (fleet === "update" && options.hubUpdateFails) return result(false, `${options.hubUpdateFails}\n`);
    if (fleet === "update") {
      hubUpdates.push(host);
      for (const node of (await pushedProfile()).devboxes ?? []) hubTook.add(node);
      return result(true, "✓ Up to date");
    }
    const linked = fleet.match(/^peers link (\S+)$/)?.[1];
    if (linked === undefined) return result(false, `unexpected on the hub: ${fleet}`);
    if (!hubTook.has(linked) || !passes("box:t3")) return result(false, `${linked}: not linked`);
    hubLinked.push(linked);
    return result(true, `linked ${linked}`);
  };
  const forReal = async (line: string, host: string, input?: string): Promise<ExecResult> => {
    const child = Bun.spawn(["sh", "-c", line], { env: { HOME: boxHome(home, host), PATH: process.env.PATH ?? "" }, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: `${stdout}${stderr}`, stdout };
  };
  let boxCoderAt = options.boxCoderAt ?? "https://coder.example.com";
  const box = async (line: string, input: string | undefined, host: string): Promise<ExecResult> => {
    const hub = await onTheHub(line, host);
    if (hub) return hub;
    if (line === "coder whoami") return passes("box:coder") ? result(true, coderWhoami.replace("https://coder.example.com", boxCoderAt)) : result(false, "You are not logged in");
    if (line.includes('CODER_SESSION_TOKEN="$token" coder login ') && line.startsWith("sh -c ")) {
      if (!line.includes("coder login --use-token-as-session https://coder.example.com")) return result(false, "CODER_SESSION_TOKEN is set. Unset it, or pass --use-token-as-session to save it as your session.");
      if (input === `${coderToken}\n`) (left["box:coder"] = 0), (boxCoderAt = "https://coder.example.com");
      return result(passes("box:coder"), passes("box:coder") ? "Welcome to Coder, nora! You're authenticated." : "invalid token");
    }
    if (line === "coder config-ssh --yes") return passes("box:coder") ? (coderSsh.push(boxCoderAt), result(true, "Updated \"~/.ssh/config\"")) : result(false, "You are not logged in");
    if (line.startsWith("gh auth status")) return ghStatus("box:github", scopes);
    if (line === "gh auth setup-git") return result(true);
    if (line === "claude auth status") return result(passes("box:claude"), JSON.stringify({ loggedIn: passes("box:claude") }));
    if (line.includes("codex exec")) return result(passes("box:chatgpt"), "ok");
    if (line.startsWith("sh -c 'if [ -f ")) return result(true, Object.entries(options.boxFiles ?? {}).map(([path, text]) => `=== file ${path}\n${text}\n`).join(""));
    if (line.includes("/.config/fleet/machine.json")) return forReal(line, host, input);
    return t3(line, "BOXCODE", input, { linked: passes("box:t3"), tunnel: "box-1.relay.example", sessions: boxSessions }) ?? result(false, `unexpected on the box: ${line}`);
  };
  const machine: Machine = {
    async exec(command, run = {}) {
      calls.push({ command, ...run });
      const remote = onBox(command);
      if (remote !== undefined) {
        const host = command.at(-2)!;
        const answer = await box(remote, run.input, host);
        const firstContact = !host.startsWith("coder.") && !reached.has(host);
        reached.add(host);
        return firstContact ? { ...answer, output: `${answer.output}${hostKeyAdded(host)}` } : answer;
      }
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
        const owner = command[3]!.split("/")[0]!;
        if (owner === options.createFails) return result(false, `GraphQL: you cannot create repos in ${owner}`);
        const bare = githubRepo(home, command[3]!);
        mkdirSync(bare, { recursive: true });
        return realGit(home, ["init", "-q", "--bare", "-b", "main", bare]);
      }
      if (command[0] === "git") return realGit(home, command.slice(1), run.cwd);
      return t3(command.map(quote).join(" "), "HERECODE", run.input, { linked: Boolean(options.connectHere), tunnel: "here.relay.example", sessions: hereSessions }) ?? result(false, `unexpected ${line}`);
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
      const remote = onBox(command);
      if (remote === "claude auth login") left["box:claude"] = 0;
      const node = command.at(-2)!;
      const { hub } = remote?.includes(" --profile ") ? await pushedProfile() : {};
      if (hub && hub !== node && !options.hubDown) credentials.push({ node, issued: hubTook.has(node) });
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
  return { machine, calls, starts, runs, sleeps, opened, coderSsh, hubUpdates, credentials, hubLinked, sessions: () => [...hereSessions, ...boxSessions] };
}

export const remote = (box: ReturnType<typeof fakeMachine>) => [...box.calls.map((call) => onBox(call.command)), ...box.starts.map(onBox), ...box.runs.map((run) => onBox(run.command))].filter(Boolean) as string[];

export async function fleetSetup(home: string, args: string[], replies: string[] = [], box = fakeMachine(home), fetchSource?: (ref: SourceRef, cache: string) => Promise<FetchedSource>, doctorCode = 0, platform: NodeJS.Platform = "linux", onApply: (dir: string) => void | Promise<void> = () => {}) {
  const io = scripted(replies);
  const applied: string[] = [];
  const doctored: string[] = [];
  const apply = async (dir: string) => (applied.push(dir), await onApply(dir), 0);
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
