import { Stopped, type Terminal } from "./terminal.ts";
import { duration } from "../commands/triage-record.ts";
import type { StepRecord } from "./timings.ts";

export type StepKind = "auto" | "question" | "human";

/** A step either finishes, or, run without a person, reports that it still needs an answer. */
export type StepOutcome = void | "unanswered";

export type Step = {
  id: string;
  title: string;
  minutes: number;
  kind: StepKind;
  run(): Promise<StepOutcome>;
};

export type RunOptions = {
  terminal: Terminal;
  done: string[];
  /** Saves the done list. A step saves its own answers before it returns, so a stop between the two loses nothing. */
  save(done: string[]): Promise<void>;
  clock?: { now(): number };
  /** Calls tick every ms until the returned stop runs. */
  every?: (ms: number, tick: () => void) => () => void;
  /** How many times setup has waited for the person so far, from questions and sign-ins. */
  waits?: () => number;
  record?(step: StepRecord): Promise<void>;
};

const heartbeatMs = 15_000;

const intervals = (ms: number, tick: () => void) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

export type RunResult = { finished: boolean; unanswered: string[] };

/**
 * Runs the first step that is not done, again and again, rebuilding the list
 * each time because answers add and remove steps. A question that a run
 * without a person cannot answer, or a sign-in it cannot wait for, is left
 * open, and the run stops before the next step that is not a question,
 * because a passing sign-in goes on to change the machine.
 */
export async function runSteps(steps: () => Step[], options: RunOptions): Promise<RunResult> {
  const done = new Set(options.done);
  const open = new Set<string>();
  const first = steps();
  const resumed = first.filter((step) => done.has(step.id)).length;
  const next = first.find((step) => !done.has(step.id));
  if (resumed && next) options.terminal.print(`Welcome back. ${resumed} of ${first.length} done, picking up at ${next.title}.`);
  for (;;) {
    const list = steps();
    const step = list.find((item) => !done.has(item.id) && !open.has(item.id));
    if (!step) return { finished: open.size === 0, unanswered: [...open] };
    if (open.size && step.kind !== "question") return { finished: false, unanswered: [...open] };
    options.terminal.print("");
    options.terminal.print(header(list, done));
    const outcome = await timed(step, options);
    if (outcome === "unanswered") {
      open.add(step.id);
      continue;
    }
    done.add(step.id);
    await options.save([...done]);
  }
}

async function timed(step: Step, options: RunOptions): Promise<StepOutcome> {
  const clock = options.clock ?? Date;
  const start = clock.now();
  const waitsBefore = options.waits?.() ?? 0;
  const stop =
    step.kind === "auto"
      ? (options.every ?? intervals)(heartbeatMs, () => options.terminal.print(`  … ${step.title}: still running, ${duration(Math.round((clock.now() - start) / 1000))} so far`))
      : () => {};
  const blocked = () => (options.waits?.() ?? 0) > waitsBefore;
  let outcome: StepOutcome;
  try {
    outcome = await step.run();
  } catch (error) {
    stop();
    if (!(error instanceof Stopped)) await options.record?.({ id: step.id, title: step.title, kind: step.kind, start, end: clock.now(), blocked: blocked(), outcome: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  stop();
  const unanswered = outcome === "unanswered";
  await options.record?.({ id: step.id, title: step.title, kind: step.kind, start, end: clock.now(), blocked: unanswered || blocked(), outcome: unanswered ? "unanswered" : "done" });
  return outcome;
}

export function header(steps: Step[], done: Set<string>) {
  const left = steps.filter((step) => !done.has(step.id));
  const minutes = Math.ceil(left.reduce((sum, step) => sum + step.minutes, 0));
  const position = Math.min(steps.length - left.length + 1, steps.length);
  return `Fleet setup · ${position} of ${steps.length} · about ${minutes} min left`;
}
