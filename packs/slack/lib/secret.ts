export type SecretReader = { read(prompt: string): Promise<string>; close(): void };
export type ReadSecret = (prompt: string) => Promise<string>;

export class Interrupted extends Error {
  constructor() {
    super("stopped before the Slack app was saved");
  }
}

type Keyboard = NodeJS.ReadStream & { setRawMode?: (raw: boolean) => unknown };

export function secretReader(input: Keyboard = process.stdin, output: NodeJS.WritableStream = process.stdout, interrupt: () => void = () => void process.kill(process.pid, "SIGINT")): SecretReader {
  const decoder = new TextDecoder();
  let typed: string[] = [];
  let ended = false;
  let raw = false;
  let swallowLineFeed = false;
  let waiting: ((line: string | Error) => void) | undefined;
  const setRaw = (on: boolean) => {
    if (raw === on || !input.isTTY || !input.setRawMode) return;
    input.setRawMode(on);
    raw = on;
  };
  const restore = () => setRaw(false);
  const finish = (line: string | Error, used: number) => {
    swallowLineFeed = typed[used - 1] === "\r";
    typed = typed.slice(used);
    const resolve = waiting;
    waiting = undefined;
    if (input.isTTY) output.write("\n");
    resolve?.(line);
    settle();
  };
  const settle = () => {
    if (swallowLineFeed && typed.length) {
      if (typed[0] === "\n") typed.shift();
      swallowLineFeed = false;
    }
    const stop = typed.indexOf("\x03");
    if (stop >= 0 && !waiting) {
      typed = [];
      return restore(), interrupt();
    }
    if (!waiting) return;
    const end = typed.findIndex((key) => key === "\r" || key === "\n");
    if (stop >= 0 && (end < 0 || stop < end)) return typed = [], finish(new Interrupted(), 0);
    if (typed[0] === "\x04") return finish(new Interrupted(), 1);
    if (end >= 0) return finish(clean(typed.slice(0, end)), end + 1);
    if (ended) finish(typed.length ? clean(typed) : new Interrupted(), typed.length);
  };
  const onData = (chunk: Buffer | string) => {
    typed.push(...(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })));
    settle();
  };
  const onEnd = () => {
    ended = true;
    settle();
  };
  process.once("exit", restore);
  return {
    read: (prompt) =>
      new Promise<string>((resolve, reject) => {
        if (!input.listeners("data").includes(onData)) input.on("data", onData).on("end", onEnd);
        setRaw(true);
        input.resume();
        output.write(prompt);
        waiting = (line) => (line instanceof Error ? reject(line) : resolve(line));
        settle();
      }),
    close() {
      restore();
      input.off("data", onData).off("end", onEnd);
      input.pause();
      process.off("exit", restore);
    },
  };
}

function clean(keys: string[]) {
  const kept: string[] = [];
  for (const key of keys) key === "\x7f" || key === "\b" ? kept.pop() : kept.push(key);
  return kept.join("").trim();
}
