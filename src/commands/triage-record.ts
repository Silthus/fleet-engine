import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Terminal } from "../setup/terminal.ts";

export const stateDir = (home: string) => join(home, ".local", "state", "fleet");
const logsDir = (home: string) => join(stateDir(home), "logs");
export const transcriptPath = (home: string) => join(logsDir(home), "setup.log");
export const failurePath = (home: string) => join(logsDir(home), "setup-failed.json");
export const timingsPath = (home: string) => join(logsDir(home), "setup-timings.json");

/** The last failed setup run: when, at which step, and the error it printed. */
export type SetupFailure = { at: string; step?: string; error: string };

export type TimedStep = { id: string; title?: string; start?: string; end?: string; blocked?: boolean; outcome?: string; error?: string };

/** The setup timings file that fleet setup writes after each step. */
export type SetupTimings = { started?: string; usable?: string; steps: TimedStep[] };

export type Recorder = {
  terminal: Terminal;
  print(line: string): void;
  /** Saves the failure of this run, with the step the transcript last showed. */
  failed(error: string, now?: Date): void;
};

/**
 * Records one fleet setup run: every line it prints and every answer typed,
 * appended to the setup transcript. A new run clears the last failure.
 * Only the user can read the records, and a record that cannot be written
 * never stops setup.
 */
export function recordSetup(home: string, terminal: Terminal, args: string[], now = new Date()): Recorder {
  const path = transcriptPath(home);
  const ready = quietly(() => {
    mkdirSync(logsDir(home), { recursive: true, mode: 0o700 });
    chmodSync(logsDir(home), 0o700);
    rmSync(failurePath(home), { force: true });
    if (existsSync(path)) chmodSync(path, 0o600);
    return true;
  });
  const write = (line: string) => void (ready && quietly(() => appendFileSync(path, `${line}\n`, { mode: 0o600 })));
  write(`=== fleet setup${args.length ? ` ${args.join(" ")}` : ""} at ${now.toISOString()}`);
  let header: string | undefined;
  let step: string | undefined;
  const print = (line: string) => {
    write(line);
    if (/^Fleet setup · \d+ of \d+/.test(line)) [header, step] = [line.split(" · ").slice(1, 2).join(""), undefined];
    else if (header && step === undefined && line.trim()) step = line.trim().replace(/^▶ /, "");
  };
  return {
    print,
    terminal: {
      ...terminal,
      print(line) {
        print(line);
        terminal.print(line);
      },
      async ask(prompt) {
        const answer = await terminal.ask(prompt);
        write(`${prompt}${answer}`);
        return answer;
      },
    },
    failed(error, at = new Date()) {
      write(`✗ ${error}`);
      const where = header ? `${header}${step ? `: ${step}` : ""}` : undefined;
      const failure: SetupFailure = { at: at.toISOString(), ...(where ? { step: where } : {}), error };
      if (ready) quietly(() => writeFileSync(failurePath(home), `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 }));
    },
  };
}

function quietly<T>(work: () => T): T | undefined {
  try {
    return work();
  } catch {
    return undefined;
  }
}

export function readFailure(home: string): SetupFailure | undefined {
  const file = readJson(failurePath(home)) as Partial<SetupFailure> | undefined;
  return typeof file?.error === "string" && typeof file.at === "string" ? { at: file.at, error: file.error, ...(typeof file.step === "string" ? { step: file.step } : {}) } : undefined;
}

export function readTimings(home: string): SetupTimings | undefined {
  const file = readJson(timingsPath(home)) as { started?: unknown; usable?: unknown; steps?: unknown } | undefined;
  if (!file || !Array.isArray(file.steps)) return undefined;
  const steps = file.steps.filter((step): step is TimedStep => typeof step === "object" && step !== null && typeof (step as TimedStep).id === "string");
  return { ...(typeof file.started === "string" ? { started: file.started } : {}), ...(typeof file.usable === "string" ? { usable: file.usable } : {}), steps };
}

/** Seconds from the start of setup to t_usable, when the timings reached it. */
export function usableSeconds(timings: SetupTimings | undefined): number | undefined {
  if (!timings?.started || !timings.usable) return undefined;
  const seconds = (Date.parse(timings.usable) - Date.parse(timings.started)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : undefined;
}

export function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** The newest lines of the setup transcript. */
export function transcriptTail(home: string, lines: number): { lines: string[]; cut: number } {
  const path = transcriptPath(home);
  if (!existsSync(path)) return { lines: [], cut: 0 };
  const all = readFileSync(path, "utf8").replace(/\n$/, "").split("\n");
  return { lines: all.slice(-lines), cut: Math.max(0, all.length - lines) };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
