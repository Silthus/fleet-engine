type SpawnOptions = { cwd?: string; env?: Record<string, string | undefined>; stdin?: "ignore" | Uint8Array; timeout?: number; signal?: AbortSignal };

export type Spawned = { exitCode: number; stdout: string; stderr: string; pid: number };

export async function spawnAsync(command: string[], { cwd, env, stdin = "ignore", timeout, signal }: SpawnOptions = {}): Promise<Spawned> {
  const child = Bun.spawn(command, { cwd, env, stdin, timeout, signal, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr, pid: child.pid };
}
