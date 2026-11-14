import { writeFileSync } from "node:fs";
import { arch, release } from "node:os";
import { join, resolve } from "node:path";
import type { CommandRunner } from "../adapters/run.ts";
import type { MachineFile, Profile } from "../pack/types.ts";
import { loadMachine, loadProfile } from "../profile/profile.ts";
import { defaultSources, engineRepo } from "../setup/defaults.ts";
import { FlagError } from "../setup/flags.ts";
import { Stopped, type Terminal } from "../setup/terminal.ts";
import { duration, readFailure, readTimings, transcriptTail, usableSeconds, type SetupTimings } from "./triage-record.ts";
import { redact, type KnownName } from "./triage-redact.ts";

export type TriageContext = {
  home: string;
  engineRoot: string;
  platform: NodeJS.Platform;
  terminal: Terminal;
  capture: CommandRunner;
  hostname: string;
  /** Runs fleet doctor and returns what it printed. */
  doctor(): Promise<string[]>;
  now?: Date;
};

export type TriageReport = { title: string; body: string; clean(text: string): string };

const transcriptLines = 400;
const bodyLimit = 60_000;
const issueUrl = `https://github.com/${engineRepo}/issues/new`;

/** fleet triage: builds a redacted report of this machine's setup, shows it, and with a yes opens an issue on the engine repo or saves it to a file. */
export async function triageCommand(args: string[], context: TriageContext): Promise<number> {
  const flags = parseFlags(args);
  const { terminal } = context;
  try {
    const note = flags.note ?? (flags.print || flags.save || flags.send ? undefined : await terminal.ask("What went wrong, in a few words? Press ↵ to skip: "));
    const report = await triageReport(context, note);
    terminal.print("");
    for (const line of [`# ${report.title}`, "", ...report.body.split("\n")]) terminal.print(line);
    terminal.print("");
    terminal.print("Fleet removed tokens, keys, email addresses, hostnames and home paths from this report. Read it before you send it.");
    if (flags.print) return 0;
    if (flags.save) return save(report, resolve(flags.save), context);
    if (flags.send) return send(report, context);
    terminal.print("");
    terminal.print("Send this report to the Fleet maintainer?");
    terminal.print(`  1) Open a public issue on github.com/${engineRepo} with it`);
    terminal.print("  2) Save it to a file that you send yourself (default)");
    terminal.print("  3) Neither");
    for (;;) {
      const choice = await terminal.ask("Press ↵ to save it, or type a number: ");
      if (choice === "1") return send(report, context);
      if (choice === "" || choice === "2") return save(report, defaultFile(context), context);
      if (choice === "3") return terminal.print("Nothing was sent or saved."), 0;
    }
  } catch (error) {
    if (!(error instanceof Stopped)) throw error;
    terminal.print("");
    terminal.print("Stopped. Nothing was sent.");
    return 130;
  }
}

/** Everything a maintainer needs to fix a setup problem, with secrets and names removed. */
export async function triageReport(context: TriageContext, note?: string): Promise<TriageReport> {
  const machine = await loadMachine(context.home).catch(() => undefined);
  const profile = machine?.profileDir ? await loadProfile(machine.profileDir).catch(() => undefined) : undefined;
  const failure = readFailure(context.home);
  const timings = readTimings(context.home);
  const [versions, doctor, gitName, origin] = await Promise.all([
    versionLines(context, profile),
    context.doctor().catch((error: Error) => [`fleet doctor could not run: ${error.message}`]),
    firstLine(context, ["git", "config", "--global", "user.name"]),
    machine?.profileDir ? firstLine(context, ["git", "-C", machine.profileDir, "remote", "get-url", "origin"]) : Promise.resolve(undefined),
  ]);
  const known = knownNames(context.hostname, machine, profile, gitName, origin);
  const clean = (text: string) => redact(text, context.home, known);
  const described = note?.trim() ? clean(note.trim()) : "Not described.";
  const facts = clean([...setupLines(machine, failure, timings), "", "## Versions", "", ...versions].join("\n"));
  const checked = clean(doctor.join("\n")).split("\n");
  const head = ["## What happened", "", described, "", "## Setup", "", facts, "", "## fleet doctor", "", fence(checked), "", ""].join("\n");
  const ending = "\n\nMade by `fleet triage`.";
  const transcript = transcriptTail(context.home, transcriptLines);
  const lines = transcript.lines.length ? clean(transcript.lines.join("\n")).split("\n") : [];
  const room = bodyLimit - head.length - ending.length - 200;
  let kept = lines.length;
  let size = lines.reduce((sum, line) => sum + line.length + 1, 0);
  while (kept > 0 && size > room) size -= lines[lines.length - kept--]!.length + 1;
  const shown = lines.slice(lines.length - kept);
  const cut = transcript.cut + lines.length - kept;
  const tail = [`## Setup transcript${cut ? ` (newest ${shown.length} lines)` : ""}`, "", shown.length ? fence(shown) : lines.length ? "The setup transcript is too long to include." : "No setup transcript on this machine."].join("\n");
  const title = shortenTo(clean(`fleet triage: ${note?.trim() || (failure ? `setup failed: ${failure.error}` : "setup report")}`).split("\n")[0]!, 120);
  return { title, body: `${head}${tail}${ending}`, clean };
}

function setupLines(machine: MachineFile | undefined, failure: ReturnType<typeof readFailure>, timings: SetupTimings | undefined) {
  const lines: string[] = [];
  if (!machine) lines.push("- No machine file: fleet setup has not saved progress on this machine.");
  else lines.push(`- Role: ${machine.role}${machine.coder ? ", a Coder workspace" : ""}`, `- Steps done: ${machine.setup?.done.length ? machine.setup.done.join(", ") : "none saved"}`);
  if (failure) lines.push(`- Failed at ${failure.at}${failure.step ? `, ${failure.step}` : ""}: ${failure.error}`);
  else lines.push("- No failed setup run is recorded.");
  const usable = usableSeconds(timings);
  if (usable !== undefined) lines.push(`- t_usable: ${duration(usable)}`);
  if (!timings) return [...lines, "- No setup timings recorded."];
  return [...lines, "", "| Step | Took | Waited on you | Result |", "| --- | --- | --- | --- |", ...timings.steps.map(timingRow)];
}

function timingRow(step: SetupTimings["steps"][number]) {
  const seconds = step.start && step.end ? Math.round((Date.parse(step.end) - Date.parse(step.start)) / 1000) : undefined;
  const took = seconds !== undefined && Number.isFinite(seconds) ? duration(seconds) : step.start ? "still running" : "";
  const result = [step.outcome ?? "", step.error ?? ""].filter(Boolean).join(": ");
  return `| ${cell(step.title ?? step.id)} | ${took} | ${step.blocked ? "yes" : "no"} | ${cell(result)} |`;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

async function versionLines(context: TriageContext, profile: Profile | undefined) {
  const os = context.platform === "darwin" ? ["sw_vers", "-productVersion"] : ["sh", "-c", '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"'];
  const tools: Array<[string, string[]]> = [
    ["Engine", ["git", "-C", context.engineRoot, "describe", "--tags", "--always", "--dirty"]],
    ["T3 Code", ["t3", "--version"]],
    ["Claude Code", ["claude", "--version"]],
    ["Codex", ["codex", "--version"]],
    ["gh", ["gh", "--version"]],
    ["Git", ["git", "--version"]],
    ["OS", os],
  ];
  const found = await Promise.all(tools.map(async ([label, command]) => [label, await firstLine(context, command)] as const));
  const lines = found.map(([label, value]) => `- ${label}: ${value ?? "not found"}`);
  const osLine = lines.pop()!;
  return [
    ...lines.slice(0, 1),
    `- Profile engine pin: ${profile ? `${profile.engine.repo}@${profile.engine.ref} (${profile.engine.channel})` : "no profile"}`,
    ...(profile ? [`- Packs: ${profile.packs.length ? profile.packs.join(", ") : "Base only"}; plan ${profile.plan}`] : []),
    ...lines.slice(1),
    `- Bun: ${Bun.version}`,
    `${osLine} (${context.platform} ${release()} ${arch()})`,
  ];
}

async function firstLine(context: TriageContext, command: string[]) {
  const answer = await context.capture(command, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  const line = answer?.code === 0 ? answer.stdout.trim().split("\n")[0]?.trim() : undefined;
  return line || undefined;
}

function knownNames(hostname: string, machine: MachineFile | undefined, profile: Profile | undefined, gitName: string | undefined, origin: string | undefined): KnownName[] {
  const names: KnownName[] = [];
  const profileRepo = origin?.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/)?.[1];
  if (profileRepo) names.push({ text: profileRepo, as: "<profile repo>" });
  const settings = { ...machine?.setup?.draft?.settings, ...profile?.settings };
  for (const value of Object.values(settings)) {
    const repo = typeof value === "string" ? value.match(/^(?:https:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] : undefined;
    if (repo) names.push({ text: repo, as: "<private repo>" });
  }
  for (const name of [hostname, machine?.name]) if (name && name !== "localhost") names.push({ text: name, as: "<this machine>" }, { text: name.split(".")[0]!, as: "<this machine>" });
  if (profile?.hub) names.push({ text: profile.hub, as: "<hub>" });
  const devboxes = [...new Set([...(machine?.devboxes ?? []), ...(profile?.devboxes ?? [])])].filter((host) => host !== profile?.hub);
  devboxes.forEach((host, index) => names.push({ text: host, as: `<devbox ${index + 1}>` }));
  const publicRepos = new Set([engineRepo, ...defaultSources.map((source) => source.repo)]);
  for (const source of [...(machine?.setup?.draft?.sources ?? []), ...(profile?.sources ?? [])]) if (!publicRepos.has(source.repo)) names.push({ text: source.repo, as: `<${source.name} source>` });
  if (gitName) names.push({ text: gitName, as: "<name>" });
  return names;
}

function shortenTo(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function fence(lines: string[]) {
  const text = lines.join("\n").replace(/```/g, "'''");
  return ["```text", text || "(nothing printed)", "```"].join("\n");
}

async function send(report: TriageReport, context: TriageContext) {
  const answer = await context.capture(["gh", "issue", "create", "--repo", engineRepo, "--title", report.title, "--body-file", "-"], { input: report.body }).catch((error: Error) => ({ code: 1, stdout: "", stderr: error.message }));
  const url = answer.stdout.trim().split("\n").find((line) => line.startsWith("https://"));
  if (answer.code === 0 && url) return context.terminal.print(`✓ Opened ${url}`), 0;
  const why = (answer.stderr ?? answer.stdout).trim().split("\n").at(-1) || `gh exited ${answer.code}`;
  context.terminal.print(`Could not open the issue: ${report.clean(why)}`);
  const path = defaultFile(context);
  write(report, path);
  context.terminal.print(`Saved the report to ${path}. Open ${issueUrl} and paste it there.`);
  return 1;
}

function save(report: TriageReport, path: string, context: TriageContext) {
  write(report, path);
  context.terminal.print(`✓ Saved the report to ${path}. Send it to the Fleet maintainer, or open ${issueUrl} and paste it.`);
  return 0;
}

function write(report: TriageReport, path: string) {
  writeFileSync(path, `# ${report.title}\n\n${report.body}\n`);
}

function defaultFile(context: TriageContext) {
  const stamp = (context.now ?? new Date()).toISOString().slice(0, 16).replace(/:/g, "-");
  return join(context.home, `fleet-triage-${stamp}.md`);
}

type TriageFlags = { note?: string; print: boolean; save?: string; send: boolean };

function parseFlags(args: string[]): TriageFlags {
  const flags: TriageFlags = { print: false, send: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = () => {
      const next = args[++index];
      if (next === undefined) throw new FlagError(`${arg} needs a value`);
      return next;
    };
    if (arg === "--note") flags.note = value();
    else if (arg === "--save") flags.save = value();
    else if (arg === "--print") flags.print = true;
    else if (arg === "--send") flags.send = true;
    else throw new FlagError(`unknown option ${arg}`);
  }
  if ([flags.print, flags.save !== undefined, flags.send].filter(Boolean).length > 1) throw new FlagError("pick one of --print, --save and --send");
  return flags;
}
