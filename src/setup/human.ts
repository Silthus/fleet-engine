import type { HumanStep, Owned, PackStep } from "../pack/types.ts";
import { quote } from "../hub/ssh.ts";
import { engineCommand, engineShellCommand } from "../reconciler/engine-command.ts";
import type { Machine } from "./commands.ts";
import type { Step, StepOutcome } from "./runner.ts";
import type { Terminal } from "./terminal.ts";

export const pollMs = 2000;

/** Polls left once the sign-in command finished well, for the probe to see the new sign-in, such as a T3 Connect tunnel after its restart. */
const graceAfterExit = 15;

function ended(signIn: SignIn, code: number) {
  const name = signIn.command![0];
  if (code === 127) return `${name} is not installed here. Install it, then run fleet setup again.`;
  return `${signIn.command!.join(" ")} ended${code ? ` with code ${code}` : ""}, but ${signIn.title} still does not pass its check. Fix what it says above, then run fleet setup again.`;
}

export type SignIn = {
  id: string;
  title: string;
  minutes: number;
  why: string;
  probe(): Promise<boolean>;
  /** The command that starts the sign-in, shown and run in the background. */
  command?: string[];
  /** The command reads the keyboard: it runs in the foreground instead, and the probe runs once it ends. */
  interactive?: true;
  /** The command ends by itself and may still work after the probe passes, such as a repair that applies the profile: setup waits for it instead of stopping it. */
  finishes?: true;
  url?: string;
  /** Runs once the probe passes, before the step counts as done. */
  after?(): Promise<void>;
};

export type HumanContext = { terminal: Terminal; machine: Machine; nonInteractive: boolean };

/**
 * A step that needs the person: it checks first, then starts the sign-in,
 * opens the browser, and polls its probe every 2 s until it passes, with no
 * key press. Run without a person, it only checks.
 */
export function humanStep(signIn: SignIn, context: HumanContext): Step {
  return { id: signIn.id, title: signIn.title, minutes: signIn.minutes, kind: "human", run: () => waitForPerson(signIn, context) };
}

async function waitForPerson(signIn: SignIn, { terminal, machine, nonInteractive }: HumanContext): Promise<StepOutcome> {
  if (await signIn.probe()) {
    terminal.print(`  ✓ ${signIn.title}: already done`);
    return signIn.after?.();
  }
  if (nonInteractive) {
    terminal.print(`  Needs you: ${signIn.title}`);
    terminal.print(`  ${howToStart(signIn)}`);
    return "unanswered";
  }
  terminal.print(`▶ ${signIn.title}  (step needs you, about ${signIn.minutes} min)`);
  terminal.print(`  ${signIn.why}`);
  if (signIn.interactive && signIn.command) return withKeyboard(signIn, { terminal, machine, nonInteractive });
  const started = signIn.command && (terminal.print(`  $ ${signIn.command.join(" ")}`), machine.start(signIn.command));
  if (signIn.url) {
    await machine.openUrl(signIn.url);
    terminal.print(`  Opened your browser. If it did not open, go to ${signIn.url}`);
  }
  terminal.print("  Waiting for you. Nothing to press here: setup notices when you are done.");
  let exit: number | undefined;
  void started?.exited.then((code) => (exit = code));
  try {
    let pollsAfterExit = 0;
    for (;;) {
      await machine.sleep(pollMs);
      if (await signIn.probe()) break;
      if (exit !== undefined && (exit !== 0 || ++pollsAfterExit > graceAfterExit)) throw new Error(ended(signIn, exit));
    }
  } finally {
    if (!signIn.finishes) started?.stop();
  }
  if (signIn.finishes && started && exit === undefined) await started.exited;
  terminal.print(`  ✓ ${signIn.title}: done`);
  return signIn.after?.();
}

function howToStart({ command, interactive, url, why }: SignIn) {
  const open = url ? `open ${url}` : undefined;
  if (!command) return open ? `Open ${url}` : why;
  return `${interactive ? "In a terminal, run" : "Run"}: ${command.map(quote).join(" ")}${open ? `, and ${open}` : ""}`;
}

async function withKeyboard(signIn: SignIn, { terminal, machine }: HumanContext): Promise<StepOutcome> {
  terminal.print(`  $ ${signIn.command!.join(" ")}`);
  terminal.print("  It needs your keyboard. Setup goes on when it ends.");
  terminal.release?.();
  const code = await machine.run(signIn.command!, { input: true });
  if (!(await signIn.probe())) throw new Error(ended(signIn, code));
  terminal.print(`  ✓ ${signIn.title}: done`);
  return signIn.after?.();
}

/** A pack's human step, followed by the pack steps that wait for it. A leading fleet in their commands runs the engine at engineRoot. */
export function packSignIn(step: Owned<HumanStep>, steps: Array<Owned<PackStep>>, context: HumanContext, engineRoot: string | undefined): SignIn {
  const { machine, terminal } = context;
  const exec = (command: string[]) => machine.exec(engineCommand(command, engineRoot));
  const passes = async (command: string[]) => (await exec(command)).code === 0;
  return {
    id: `human:${step.pack}:${step.id}`,
    title: step.say,
    minutes: 2,
    why: `The ${step.pack} pack needs this.`,
    probe: () => passes(step.probe),
    ...(step.command ? { command: ["sh", "-c", engineShellCommand(step.command, engineRoot)] } : {}),
    ...(step.command && /^fleet( \S+)+$/.test(step.command) ? { finishes: true as const } : {}),
    ...(step.interactive ? { interactive: true as const } : {}),
    async after() {
      for (const next of steps.filter((item) => item.pack === step.pack && item.after === step.id)) {
        if (next.check && (await passes(next.check))) continue;
        terminal.print(`  $ ${next.run.join(" ")}`);
        const result = await exec(next.run);
        if (result.code !== 0 || (next.check && !(await passes(next.check)))) {
          throw new Error(`step ${next.id} of the ${step.pack} pack failed${result.output.trim() ? `: ${result.output.trim().split("\n").at(-1)}` : ""}`);
        }
      }
    },
  };
}
