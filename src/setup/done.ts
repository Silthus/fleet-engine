import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MachineRole, PackJob, PackManifest, Plan } from "../pack/types.ts";
import type { Machine } from "./commands.ts";
import { overSsh } from "./devbox.ts";
import type { Step } from "./runner.ts";
import type { Terminal } from "./terminal.ts";

export const firstPrompt = "Look around this repo and suggest three small improvements. When I pick one, make it on a branch and open a draft pull request for me to review.";

const signingCheck = 'd=$(mktemp -d) && cd "$d" && git init -q && git commit -q -S --allow-empty -m "Fleet signing check" && git verify-commit HEAD >/dev/null 2>&1; s=$?; cd / && rm -rf "$d"; exit $s';

export type FinalCheckContext = {
  terminal: Terminal;
  machine: Machine;
  home: string;
  devboxes: string[];
  /** Runs fleet doctor on this machine's profile and prints its report. */
  doctor(): Promise<number>;
};

/** fleet doctor here and on each devbox, a signed commit on each devbox, and the standalone check. */
export function finalCheck(context: FinalCheckContext): Step {
  return {
    id: "check",
    title: "Check everything",
    minutes: 1,
    kind: "auto",
    async run() {
      const { terminal } = context;
      terminal.print("▶ Check everything");
      if ((await context.doctor()) !== 0) throw new Error("fleet doctor found something to fix on this machine. Fix what it says above, then run fleet setup again.");
      for (const host of context.devboxes) {
        const box = overSsh(context.machine, host);
        terminal.print(`  $ ssh ${host} fleet doctor`);
        if ((await box.run(["sh", "-c", 'sh "$HOME/.local/share/fleet/engine/fleet" doctor'])) !== 0) throw new Error(`fleet doctor found something to fix on ${host}. Fix what it says above, then run fleet setup again.`);
        if ((await box.run(["sh", "-c", signingCheck])) !== 0) throw new Error(`A signed test commit failed on ${host}. Run fleet doctor there, then run fleet setup again.`);
        terminal.print(`  ✓ ${host} makes signed commits`);
      }
      const problems = standaloneProblems(context.home);
      for (const problem of problems) terminal.print(`  ! ${problem}`);
      if (!problems.length) terminal.print("  ✓ Standalone: nothing points at a hub, a tunnel, or a proxy");
    },
  };
}

/** What would make this machine depend on another one: a proxy for Claude or Codex, or files from a Fleet hub. */
export function standaloneProblems(home: string): string[] {
  const problems: string[] = [];
  const claude = readJson(join(home, ".claude/settings.json")) as { env?: Record<string, unknown> } | undefined;
  const base = claude?.env?.ANTHROPIC_BASE_URL;
  if (typeof base === "string") problems.push(`Claude Code sends its requests to ${base} (env.ANTHROPIC_BASE_URL in ~/.claude/settings.json).`);
  const codex = readToml(join(home, ".codex/config.toml")) as { model_provider?: unknown; model_providers?: Record<string, { base_url?: unknown }> } | undefined;
  const provider = typeof codex?.model_provider === "string" ? codex.model_provider : undefined;
  const url = provider ? codex?.model_providers?.[provider]?.base_url : undefined;
  if (typeof url === "string") problems.push(`Codex sends its requests to ${url} (model_provider ${provider} in ~/.codex/config.toml).`);
  for (const file of [".config/fleet/peers.json", ".config/fleet/ssh-tunnels.json"]) {
    if (existsSync(join(home, file))) problems.push(`~/${file} is left from a Fleet hub. Remove it if this machine no longer uses one.`);
  }
  return problems;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readToml(path: string): unknown {
  try {
    return Bun.TOML.parse(readFileSync(path, "utf8"));
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
    "",
    "Paste this into a new thread in T3 Code to start:",
    "",
    `  ${firstPrompt}`,
  ];
}

/** The jobs that run without anyone starting them, named by their workflow when they have one. */
export function runsByItself(plan: Plan, manifests: PackManifest[]): string[] {
  const workflows = new Map(manifests.flatMap((manifest) => (manifest.workflows ?? []).map((workflow) => [workflow.id, workflow.name] as const)));
  const grouped = new Map<string, Set<string>>();
  for (const job of plan.jobs) {
    const name = (job.workflow && workflows.get(job.workflow)) || job.id;
    grouped.set(name, (grouped.get(name) ?? new Set()).add(schedule(job)));
  }
  return [...grouped].map(([name, times]) => `${name}, ${joinTimes([...times])}`);
}

const everyWords = { "5m": "every 5 minutes", "15m": "every 15 minutes", "1h": "every hour", "1d": "every day" };

function schedule(job: PackJob) {
  return job.schedule.at ? `${everyWords[job.schedule.every]} at ${job.schedule.at}` : everyWords[job.schedule.every];
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
