import { homedir } from "node:os";

export type HookResult = { code: number; stdout: string; stderr: string };
export type ReadInput = () => Promise<string>;
export type Hook = (provider: string, readInput: ReadInput, home: string) => HookResult | Promise<HookResult>;

export const quiet: HookResult = { code: 0, stdout: "", stderr: "" };
export const printing = (answer: object | undefined): HookResult => (answer ? { ...quiet, stdout: `${JSON.stringify(answer)}\n` } : quiet);
export const blocking = (reason: string | undefined): HookResult => (reason ? { code: 2, stdout: "", stderr: `${reason}\n` } : quiet);

export async function runHook(hook: Hook, { exitOnAnswer = false } = {}) {
  const result = await hook(process.argv[2] ?? "", () => Bun.stdin.text(), process.env.HOME ?? homedir());
  if (!exitOnAnswer) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.code;
    return;
  }
  await Bun.write(Bun.stdout, result.stdout);
  await Bun.write(Bun.stderr, result.stderr);
  process.exit(result.code);
}
