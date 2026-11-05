import type { Spawn } from "./analyze.ts";

export type After = (ms: number, stop: () => void) => () => void;

export const realTimer: After = (ms, stop) => {
  const timer = setTimeout(stop, ms);
  return () => clearTimeout(timer);
};

function stopGroup(group: number) {
  try { process.kill(-group, "SIGKILL"); } catch {}
}

export function boundedSpawn(after: After = realTimer): Spawn {
  return async (argv, options) => {
    const child = Bun.spawn(argv, { cwd: options.cwd, env: options.env as Record<string, string>, stdin: new Blob([options.stdin]), stdout: "pipe", stderr: "ignore", detached: true });
    let timedOut = false;
    const clear = after(options.timeoutMs, () => { timedOut = true; stopGroup(child.pid); });
    try {
      const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return { code, stdout, timedOut };
    } finally {
      clear();
    }
  };
}
