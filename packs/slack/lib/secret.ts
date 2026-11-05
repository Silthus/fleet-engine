export type ReadSecret = (prompt: string) => Promise<string>;

export class Interrupted extends Error {
  constructor() {
    super("stopped before the Slack app was saved");
  }
}

type Keyboard = NodeJS.ReadStream & { setRawMode?: (raw: boolean) => unknown };

export function secretReader(input: Keyboard = process.stdin, output: NodeJS.WritableStream = process.stdout): ReadSecret {
  let typed = "";
  let ended = false;
  let waiting: ((line: string | Error) => void) | undefined;
  const raw = (on: boolean) => input.isTTY && input.setRawMode?.(on);
  const settle = () => {
    for (let index = 0; index < typed.length; index++) {
      const key = typed[index]!;
      if (key === "\x03") return finish(new Interrupted(), index);
      if (key === "\r" || key === "\n") return finish(clean(typed.slice(0, index)), index);
      if (key === "\x04" && index === 0) return finish(new Interrupted(), index);
    }
    if (ended) finish(typed ? clean(typed) : new Interrupted(), typed.length);
  };
  const finish = (line: string | Error, index: number) => {
    typed = typed.slice(typed[index] === "\r" && typed[index + 1] === "\n" ? index + 2 : index + 1);
    const resolve = waiting;
    waiting = undefined;
    raw(false);
    input.pause();
    if (input.isTTY) output.write("\n");
    resolve?.(line);
  };
  input.on("data", (chunk: Buffer | string) => {
    typed += chunk.toString();
    if (waiting) settle();
  });
  input.on("end", () => {
    ended = true;
    if (waiting) settle();
  });
  return (prompt) =>
    new Promise<string>((resolve, reject) => {
      output.write(prompt);
      waiting = (line) => (line instanceof Error ? reject(line) : resolve(line));
      raw(true);
      input.resume();
      settle();
    });
}

function clean(line: string) {
  let kept = "";
  for (const key of line) kept = key === "\x7f" || key === "\b" ? kept.slice(0, -1) : kept + key;
  return kept.trim();
}
