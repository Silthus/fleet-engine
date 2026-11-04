import type { Terminal } from "./terminal.ts";

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
    if ((await step.run()) === "unanswered") {
      open.add(step.id);
      continue;
    }
    done.add(step.id);
    await options.save([...done]);
  }
}

export function header(steps: Step[], done: Set<string>) {
  const left = steps.filter((step) => !done.has(step.id));
  const minutes = Math.ceil(left.reduce((sum, step) => sum + step.minutes, 0));
  const position = Math.min(steps.length - left.length + 1, steps.length);
  return `Fleet setup · ${position} of ${steps.length} · about ${minutes} min left`;
}
