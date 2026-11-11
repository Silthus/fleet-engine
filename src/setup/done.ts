import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultTime } from "../adapters/jobs/schedule.ts";
import type { MachineRole, PackJob, PackManifest, Plan } from "../pack/types.ts";
import type { Machine } from "./commands.ts";
import { overSsh } from "./devbox.ts";
import type { Step } from "./runner.ts";
import { duration } from "../commands/triage-record.ts";
import type { Terminal } from "./terminal.ts";

export const firstPrompt = "Look around this repo and suggest three small improvements. When I pick one, make it on a branch and open a draft pull request for me to review.";

const signingCheck = 'd=$(mktemp -d) && cd "$d" && git init -q && git commit -q -S --allow-empty -m "Fleet signing check" && git verify-commit HEAD >/dev/null 2>&1; s=$?; cd / && rm -rf "$d"; exit $s';

export type FinalCheckContext = {
  terminal: Terminal;
  machine: Machine;
  home: string;
  env: Record<string, string | undefined>;
  devboxes: string[];
  /** Runs fleet doctor on this machine's profile and prints its report. */
  doctor(): Promise<number>;
};

/** fleet doctor here and on each devbox, a signed commit on each devbox, and the standalone check on every machine. Its id names the devboxes, so adding one checks again. */
export function finalCheck(context: FinalCheckContext): Step {
  return {
    id: ["check", ...context.devboxes].join(":"),
    title: "Check everything",
    minutes: 1,
    kind: "auto",
    async run() {
      const { terminal } = context;
      terminal.print("▶ Check everything");
      if ((await context.doctor()) !== 0) throw new Error("fleet doctor found something to fix on this machine. Fix what it says above, then run fleet setup again.");
      const problems = standaloneProblems(here(context.home, context.env));
      for (const host of context.devboxes) {
        const box = overSsh(context.machine, host);
        terminal.print(`  $ ssh ${host} fleet doctor`);
        if ((await box.run(["sh", "-c", 'sh "$HOME/.local/share/fleet/engine/fleet" doctor'])) !== 0) throw new Error(`fleet doctor found something to fix on ${host}. Fix what it says above, then run fleet setup again.`);
        if ((await box.run(["sh", "-c", signingCheck])) !== 0) throw new Error(`A signed test commit failed on ${host}. Run fleet doctor there, then run fleet setup again.`);
        terminal.print(`  ✓ ${host} makes signed commits`);
        problems.push(...standaloneProblems(await onDevbox(box, host)));
      }
      for (const problem of problems) terminal.print(`  ! ${problem}`);
      const where = context.devboxes.length ? `, here or on ${context.devboxes.join(", ")}` : "";
      if (!problems.length) terminal.print(`  ✓ Standalone: no proxy, hub, or tunnel in the Claude Code and Codex user settings, the environment, or Fleet's files${where}`);
    },
  };
}

const settingsFiles = [".claude/settings.json", ".codex/config.toml"];
const hubFiles = [".config/fleet/peers.json", ".config/fleet/ssh-tunnels.json"];
const proxyVariables = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"];

/** Where the standalone check reads: a machine's files under its home, and its environment. */
export type StandalonePlace = { host?: string; file(path: string): string | undefined; env(name: string): string | undefined };

export function here(home: string, env: Record<string, string | undefined>): StandalonePlace {
  return { file: (path) => readText(join(home, path)), env: (name) => env[name] || undefined };
}

/** Reads a devbox's files and environment over SSH in one call. */
export async function onDevbox(box: Machine, host: string): Promise<StandalonePlace> {
  const script = [
    ...[...settingsFiles, ...hubFiles].map((path) => `if [ -f "$HOME/${path}" ]; then echo '=== file ${path}'; cat "$HOME/${path}"; echo; fi`),
    ...proxyVariables.map((name) => `if [ -n "$${name}" ]; then echo '=== env ${name}'; echo "$${name}"; fi`),
  ].join("; ");
  const { output } = await box.exec(["sh", "-c", script]);
  const sections = new Map<string, string>();
  for (const part of output.split(/^=== /m).slice(1)) {
    const newline = part.indexOf("\n");
    sections.set(part.slice(0, newline), part.slice(newline + 1).trim());
  }
  return { host, file: (path) => sections.get(`file ${path}`), env: (name) => sections.get(`env ${name}`) || undefined };
}

/** What would make a machine depend on another one: a proxy for Claude or Codex, in user settings or the environment, or files from a Fleet hub. */
export function standaloneProblems(place: StandalonePlace): string[] {
  const at = place.host ? ` on ${place.host}` : "";
  const problems: string[] = [];
  const claude = parse(place.file(".claude/settings.json"), JSON.parse) as { env?: Record<string, unknown> } | undefined;
  const base = claude?.env?.ANTHROPIC_BASE_URL;
  const anthropic = place.env("ANTHROPIC_BASE_URL");
  if (typeof base === "string") problems.push(`Claude Code${at} sends its requests to ${base} (env.ANTHROPIC_BASE_URL in ~/.claude/settings.json).`);
  else if (anthropic) problems.push(`Claude Code${at} sends its requests to ${anthropic} (ANTHROPIC_BASE_URL in the environment).`);
  const codex = parse(place.file(".codex/config.toml"), Bun.TOML.parse) as { model_provider?: unknown; model_providers?: Record<string, { base_url?: unknown }> } | undefined;
  const provider = typeof codex?.model_provider === "string" ? codex.model_provider : undefined;
  const url = provider ? codex?.model_providers?.[provider]?.base_url : undefined;
  const openai = place.env("OPENAI_BASE_URL");
  if (typeof url === "string") problems.push(`Codex${at} sends its requests to ${url} (model_provider ${provider} in ~/.codex/config.toml).`);
  else if (openai) problems.push(`Codex${at} sends its requests to ${openai} (OPENAI_BASE_URL in the environment).`);
  for (const file of hubFiles) {
    if (place.file(file) !== undefined) problems.push(`~/${file}${at} is left from a Fleet hub. Remove it if this machine no longer uses one.`);
  }
  return problems;
}

function readText(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function parse(text: string | undefined, parser: (text: string) => unknown): unknown {
  if (text === undefined) return undefined;
  try {
    return parser(text);
  } catch {
    return undefined;
  }
}

export type DoneSummary = {
  role: MachineRole;
  packs: string[];
  devboxes: string[];
  profileRepo: string;
  runsByItself: string[];
  /** Seconds from the start of setup until the user could start a first thread, when the timings reached it. */
  usableSeconds?: number;
};

const machineNames: Record<MachineRole, string> = { mac: "This Mac", linux: "This machine", devbox: "This devbox", hub: "This hub" };

export function doneScreen(summary: DoneSummary): string[] {
  const row = (label: string, text: string) => `  ${label.padEnd(16)}${text}`;
  return [
    "",
    "✓ Fleet is set up.",
    "",
    row(machineNames[summary.role], `${summary.packs.length ? summary.packs.join(", ") : "Base only"}. fleet doctor passes.`),
    ...summary.devboxes.map((host) => row("Devbox", `${host}: the same profile, signed in, linked with T3 Code here, and it makes signed commits.`)),
    ...(summary.devboxes.length ? [] : [row("Devbox", "none. Add one with fleet devbox add <ssh host>.")]),
    row("Profile", `${summary.profileRepo}, private. Change it with fleet packs and fleet set.`),
    row("Runs by itself", summary.runsByItself.length ? summary.runsByItself[0]! : "nothing yet"),
    ...summary.runsByItself.slice(1).map((text) => row("", text)),
    ...(summary.usableSeconds === undefined ? [] : [row("Ready after", duration(summary.usableSeconds))]),
    row("Report", "fleet triage sends a report of this setup to the Fleet maintainer."),
    "",
    "Paste this into a new thread in T3 Code to start:",
    "",
    `  ${firstPrompt}`,
  ];
}

/** The jobs that run without anyone starting them, named by their workflow when they have one. Jobs that run only on a devbox name it. */
export function runsByItself(plan: Plan, manifests: PackManifest[], devboxes: Array<{ host: string; plan: Plan }> = []): string[] {
  const lines = jobLines(plan, manifests);
  const elsewhere = new Map<string, string[]>();
  for (const box of devboxes) {
    for (const line of jobLines(box.plan, manifests)) if (!lines.includes(line)) elsewhere.set(line, [...(elsewhere.get(line) ?? []), box.host]);
  }
  return [...lines, ...[...elsewhere].map(([line, hosts]) => `${line}, on ${hosts.join(" and ")}`)];
}

function jobLines(plan: Plan, manifests: PackManifest[]): string[] {
  const workflows = new Map(manifests.flatMap((manifest) => (manifest.workflows ?? []).map((workflow) => [workflow.id, workflow.name] as const)));
  const grouped = new Map<string, Set<string>>();
  for (const job of plan.jobs) {
    const name = (job.workflow && workflows.get(job.workflow)) || job.id;
    grouped.set(name, (grouped.get(name) ?? new Set()).add(schedule(job)));
  }
  return [...grouped].map(([name, times]) => `${name}, ${joinTimes([...times])}`);
}

const everyWords = { "5m": "every 5 minutes", "15m": "every 15 minutes" };

function schedule(job: PackJob) {
  if (job.schedule.every === "always") return "all the time";
  const { every, at = defaultTime } = job.schedule;
  if (every === "1d") return `every day at ${at}`;
  if (every === "1h") return `every hour at :${at.split(":")[1]}`;
  return everyWords[every];
}

function joinTimes(times: string[]) {
  const daily = times.filter((time) => time.startsWith("every day at "));
  if (daily.length < 2) return times.join(" and ");
  return [`every day at ${daily.map((time) => time.slice("every day at ".length)).join(" and ")}`, ...times.filter((time) => !daily.includes(time))].join(", and ");
}

/** owner/name from a GitHub clone URL. */
export function repoName(url: string) {
  return url.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
}
