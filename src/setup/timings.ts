import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { timingsPath } from "../commands/triage-record.ts";
import type { StepKind } from "./runner.ts";

export { timingsPath };
/** get.sh writes this: a line "start <epoch s>", then one line "<phase> <epoch s when it ended> [needed-you]" per phase. */
export const installLogPath = (home: string) => join(home, ".local/state/fleet/logs/install-timings");

/** An install log older than this belongs to an earlier install, not to this setup. */
const installLogMaxAgeMs = 2 * 3600 * 1000;

export type StepTiming = {
  id: string;
  title: string;
  kind: StepKind;
  start: string;
  end: string;
  seconds: number;
  /** The step waited for the person: a question, a confirmation, or a sign-in. */
  blocked: boolean;
  outcome: "done" | "unanswered" | "failed";
  error?: string;
};

/** The time from the start of the install to a machine the person can use, step by step. fleet setup writes it after each step. */
export type Timings = {
  schema: 1;
  started: string;
  steps: StepTiming[];
  usable: string | null;
  usableSeconds: number | null;
  /** How many steps waited for the person at least once. */
  blockedSteps: number;
};

const installTitles: Record<string, string> = {
  tools: "Install the tools",
  t3: "Install the t3 command",
  engine: "Fetch the engine",
  packages: "Install the engine's packages",
};

export type StepRecord = Pick<StepTiming, "id" | "title" | "kind" | "blocked" | "outcome" | "error"> & { start: number; end: number };

/** A timings file that cannot be written never stops setup. */
export type TimingsLog = {
  record(step: StepRecord): Promise<void>;
  /** Marks the machine usable, when a step ran in this record. */
  usable(at: number): Promise<void>;
};

/** Continues the record of a setup that is not usable yet, or of an unfinished setup that this run resumes. Otherwise it starts a new one at the start of get.sh, or now. */
export function openTimings(home: string, now: number, resumed = false): TimingsLog {
  const path = timingsPath(home);
  const earlier = read(path);
  let timings: Timings = earlier && (earlier.usable === null || resumed) ? earlier : fresh(home, now);
  let wrote = timings === earlier;
  const save = async () => {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(timings, null, 2)}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      wrote = true;
    } catch {}
  };
  return {
    async record(step) {
      const entry: StepTiming = { id: step.id, title: step.title, kind: step.kind, start: iso(step.start), end: iso(step.end), seconds: seconds(step.end - step.start), blocked: step.blocked, outcome: step.outcome, ...(step.error ? { error: step.error } : {}) };
      timings = { ...timings, steps: [...timings.steps, entry], blockedSteps: new Set([...timings.steps, entry].filter((item) => item.blocked).map((item) => item.id)).size };
      await save();
    },
    async usable(at) {
      if (!wrote || timings.usable) return;
      timings = { ...timings, usable: iso(at), usableSeconds: seconds(at - Date.parse(timings.started)) };
      await save();
    },
  };
}

function fresh(home: string, now: number): Timings {
  const install = installPhases(home, now);
  const started = install?.started ?? now;
  const steps = install?.steps ?? [];
  return { schema: 1, started: iso(started), steps, usable: null, usableSeconds: null, blockedSteps: steps.filter((step) => step.blocked).length };
}

function installPhases(home: string, now: number): { started: number; steps: StepTiming[] } | undefined {
  const path = installLogPath(home);
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((words) => words.length >= 2 && /^\d+$/.test(words[1]!));
  const first = lines[0];
  if (first?.[0] !== "start") return undefined;
  const started = Number(first[1]) * 1000;
  if (now - started > installLogMaxAgeMs || started > now) return undefined;
  const steps: StepTiming[] = [];
  let previous = started;
  for (const [phase, ended, flag] of lines.slice(1)) {
    const end = Number(ended) * 1000;
    steps.push({ id: `install:${phase}`, title: installTitles[phase!] ?? phase!, kind: flag === "needed-you" ? "human" : "auto", start: iso(previous), end: iso(end), seconds: seconds(end - previous), blocked: flag === "needed-you", outcome: "done" });
    previous = end;
  }
  return { started, steps };
}

function read(path: string): Timings | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Timings;
    return parsed.schema === 1 && Array.isArray(parsed.steps) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const seconds = (ms: number) => Math.round(ms / 1000);

