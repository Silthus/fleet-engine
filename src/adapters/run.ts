export type RunOptions = { input?: string; home?: string };
export type CommandRunner = (command: string[], options?: RunOptions) => Promise<{ code: number; stdout: string; stderr?: string }>;

export const spawnRunner: CommandRunner = async (command, options = {}) => {
  try {
    const child = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
      env: options.home === undefined ? Bun.env : { ...Bun.env, HOME: options.home },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  } catch {
    return { code: 127, stdout: "" };
  }
};
