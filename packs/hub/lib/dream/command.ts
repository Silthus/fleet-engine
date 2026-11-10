import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Env, Result } from "../coder.ts";
import { readRole } from "../machine.ts";
import { analyze, render, type Analyst } from "./analyze.ts";
import { audit, type Checker } from "./audit.ts";
import { budget, homeCheckouts } from "./budget.ts";
import { collect, dateOf, type DreamBoxes } from "./collect.ts";
import { digestLines, dreamIsOn, dreamPromptStart, dreamSessionsKey, localDigests, memoryCheckout, parseSince, redactDigest, stateDir } from "./digest.ts";
import { scorecardText } from "./scorecard.ts";

export { dreamPeers } from "./collect.ts";

export type DreamIo = {
  home: string; env: Env; self: string; now(): number;
  print(text: string): void; say(line: string): void;
  peers(): string[];
  onPeer(alias: string, command: string): Promise<Result>;
  boxes(): DreamBoxes | undefined;
  git(args: string[]): Promise<Result>;
  analyst(): Analyst;
  checker(): Checker;
  launch(title: string, prompt: string): Promise<string>;
};

const usage = `Usage:
  fleet dream digest [--since <2d | 36h | ISO time>]   Print this machine's condensed sessions as JSON lines
  fleet dream collect [--since 2d]                      On the hub: gather the digests of every machine and running box
  fleet dream analyze [<run>] [--limit n] [--jobs 6]    Ask one analyst per collected session for findings
  fleet dream audit [<run>] [--limit 40]                Check each note the sync wrote since the last audit against its session
  fleet dream prepare [--since 2d]                      collect, analyze, then audit; prints the run directory
  fleet dream run                                       On the hub: prepare, then start the T3 thread that follows the dream skill
  fleet dream budget [<memory checkout>] [--json]       Check the memory size limits; exit 1 when one fails
  fleet dream scorecard [<memory checkout>]             On the hub: print the memory scorecard
  fleet dream logs [--since 7d]                         Print this machine's Dream sessions, for the deep dream`;

const memoryRefusal = "Dream needs the Memory pack: turn it on, then run fleet apply";
const dreamOff = "Dream is off: turn it on with fleet packs --workflows dream=on, then run fleet apply";
const hubOnly = ["collect", "prepare", "run"];
const spending = ["analyze", "audit", "prepare", "run"];

const option = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const positional = (args: string[]) => (args[0] && !args[0].startsWith("--") ? resolve(args[0]) : undefined);
const settingsOf = (env: Env): Record<string, unknown> => JSON.parse(env.FLEET_SETTINGS ?? "{}");

function collectNow(args: string[], io: DreamIo): Promise<string> {
  return collect(option(args, "--since") ?? "2d", { ...io, peers: io.peers() });
}

function analyzeRun(run: string, args: string[], io: DreamIo): Promise<string> {
  const limit = Number(option(args, "--limit") ?? settingsOf(io.env)[dreamSessionsKey]);
  return analyze(run, { home: io.home, env: io.env, limit, jobs: Number(option(args, "--jobs") ?? 6), analyst: io.analyst(), say: io.say });
}

function auditRun(run: string, args: string[], io: DreamIo): Promise<string> {
  return audit(run, { home: io.home, env: io.env, now: io.now, limit: Number(option(args, "--limit") ?? 40), git: io.git, checker: io.checker(), say: io.say });
}

async function prepareRun(args: string[], io: DreamIo): Promise<string> {
  const run = await analyzeRun(await collectNow(args, io), args, io);
  try {
    await auditRun(run, [], io);
  } catch (error) {
    io.say(`Fleet dream: audit failed: ${(error as Error).message}`);
  }
  return run;
}

function logs(args: string[], io: DreamIo): number {
  const items = localDigests(io.home, io.self, parseSince(option(args, "--since") ?? "7d", io.now()), io.env, true).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (!items.length) return io.print("No Dream session in that time on this machine. Run it on the hub."), 0;
  io.print(items.map((item) => `${render(redactDigest(item))}\n\n---\n`).join("\n"));
  return 0;
}

async function nightly(args: string[], io: DreamIo): Promise<number> {
  let run: string;
  try {
    run = await prepareRun(args, io);
  } catch (error) {
    io.say(`Fleet dream: prepare failed: ${(error as Error).message}`);
    return 1;
  }
  try {
    const thread = await io.launch(`Dream ${dateOf(io.now())}`, `${dreamPromptStart} with the run directory ${run}.`);
    io.print(`Started the dream thread ${thread} for ${run}`);
    return 0;
  } catch (error) {
    io.say(`Fleet dream: cannot start the dream thread: ${(error as Error).message}`);
    return 1;
  }
}

async function printRun(command: string, work: () => Promise<string>, io: DreamIo): Promise<number> {
  try {
    io.print(await work());
    return 0;
  } catch (error) {
    io.say(`Fleet dream: ${command} failed: ${(error as Error).message}`);
    return 1;
  }
}

function requireHub(io: DreamIo, command: string) {
  const role = readRole(io.home);
  if (role !== "hub") throw new Error(`fleet dream ${command} runs only on the hub. This machine's role is ${role ?? "not set"}.`);
}

export async function dreamCommand(args: string[], io: DreamIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === "digest") {
    const since = option(rest, "--since");
    io.print(digestLines(io.home, io.self, parseSince(since, io.now()), io.now(), io.env));
    return 0;
  }
  if (!command || !["collect", "analyze", "audit", "prepare", "run", "budget", "scorecard", "logs"].includes(command)) {
    io.print(`${usage}\n`);
    return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
  if (typeof settingsOf(io.env)["memory.repo"] !== "string") return io.say(memoryRefusal), 1;
  if (spending.includes(command) && !dreamIsOn(io.env)) return io.say(dreamOff), 1;
  const state = stateDir(io.home, io.env);
  if (command === "run") {
    try { requireHub(io, command); } catch (error) { return io.say(`Fleet dream: ${(error as Error).message}`), 1; }
    return nightly(rest, io);
  }
  if (hubOnly.includes(command)) requireHub(io, command);
  if (command === "collect") return io.print(await collectNow(rest, io)), 0;
  if (command === "prepare") return printRun(command, () => prepareRun(rest, io), io);
  if (command === "analyze") return printRun(command, () => analyzeRun(positional(rest) ?? join(state, dateOf(io.now())), rest, io), io);
  if (command === "audit") return printRun(command, () => auditRun(positional(rest) ?? join(state, dateOf(io.now())), rest, io), io);
  if (command === "logs") return logs(rest, io);
  const checkout = positional(rest) ?? memoryCheckout(io.home, io.env);
  if (command === "scorecard") {
    const git = async (gitArgs: string[]) => {
      const answer = await io.git(["-C", checkout, ...gitArgs]);
      if (answer.code !== 0) throw new Error(`git ${gitArgs[0]} failed in ${checkout}: ${answer.stderr.trim()}`);
      return answer.stdout;
    };
    io.print(await scorecardText(state, checkout, git, io.now()));
    return 0;
  }
  const subtree = settingsOf(io.env)["memory.subtree"];
  const root = positional(rest) && typeof subtree === "string" && subtree && existsSync(join(checkout, subtree, "MEMORY.md")) ? join(checkout, subtree) : checkout;
  const usagePath = join(state, "usage.json");
  const problems = budget(root, existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : {}, io.now(), homeCheckouts(io.home));
  if (rest.includes("--json")) io.print(JSON.stringify(problems, null, 2));
  else io.print(problems.length ? problems.map((item) => `${item.file}: ${item.problem}`).join("\n") : "Memory is within budget.");
  return problems.length ? 1 : 0;
}
