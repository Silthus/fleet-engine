import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Run, RunResult } from "../../mcp-gateway/lib/hub.ts";

export function fakeRun(answer: (command: string[], input?: string) => Partial<RunResult> | undefined = () => undefined) {
  const calls: string[] = [];
  const inputs: string[] = [];
  const run: Run = async (command, options) => {
    calls.push(command.join(" "));
    if (options?.input !== undefined) inputs.push(options.input);
    return { code: 0, stdout: "", stderr: "", ...answer(command, options?.input) };
  };
  return { run, calls, inputs };
}

export function roleHome(home: string, role: string) {
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role }));
  return home;
}

export const modeOf = (stat: { mode: number }) => (stat.mode & 0o777).toString(8);
