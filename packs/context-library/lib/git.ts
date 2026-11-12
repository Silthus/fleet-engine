export type Run = { code: number; stdout: string; stderr: string };
export type Git = (args: string[], cwd: string) => Promise<Run>;

export const runGit: Git = async (args, cwd) => {
  const child = Bun.spawn(["git", "-c", "core.quotePath=false", ...args], { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};

export async function must(git: Git, args: string[], cwd: string) {
  const result = await git(args, cwd);
  if (result.code) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}
