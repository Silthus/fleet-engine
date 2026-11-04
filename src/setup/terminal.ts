import { createInterface, type Interface } from "node:readline";

export class Stopped extends Error {
  constructor() {
    super("stopped");
  }
}

export type Terminal = {
  print(line: string): void;
  /** Resolves to the typed line, or throws Stopped on Ctrl-C or the end of input. */
  ask(prompt: string): Promise<string>;
  /** Lets go of the keyboard until the next question, so a command run in the foreground can read it. */
  release?(): void;
};

export function ttyTerminal(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Terminal {
  let reader: Interface | undefined;
  let lines: AsyncIterator<string> | undefined;
  let interrupt: (() => void) | undefined;
  let stopping = false;
  process.once("exit", () => reader?.close());
  const open = () => {
    if (reader && lines) return lines;
    reader = createInterface({ input, output, terminal: Boolean((input as { isTTY?: boolean }).isTTY) });
    reader.on("SIGINT", () => {
      stopping = true;
      if (interrupt) interrupt();
      else process.kill(process.pid, "SIGINT");
    });
    lines = reader[Symbol.asyncIterator]();
    return lines;
  };
  return {
    print: (line) => void output.write(`${line}\n`),
    release() {
      reader?.close();
      reader = undefined;
      lines = undefined;
    },
    async ask(prompt) {
      const next = open();
      if (stopping) throw new Stopped();
      output.write(prompt);
      const stopped = new Promise<never>((_, reject) => (interrupt = () => reject(new Stopped())));
      try {
        const line = await Promise.race([next.next(), stopped]);
        if (line.done) throw new Stopped();
        return line.value.trim();
      } finally {
        interrupt = undefined;
      }
    },
  };
}
