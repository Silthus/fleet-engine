import { cpSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(import.meta.dir, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export function isolateGit() {
  Object.assign(process.env, gitEnv);
}

export function git(dir: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, env: gitEnv });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export async function spawnGit(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: dir, env: gitEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

export function tempDirs() {
  const dirs: string[] = [];
  return {
    make(prefix = "fleet-test-") {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

const pathFiles = new Set(["config", "gitdir", ".git"]);

function relocate(from: string, to: string, dir = to) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (target.startsWith(from)) {
        rmSync(path);
        symlinkSync(to + target.slice(from.length), path);
      }
    } else if (entry.isDirectory()) relocate(from, to, path);
    else if (pathFiles.has(entry.name)) {
      const text = readFileSync(path, "utf8");
      if (text.includes(from)) writeFileSync(path, text.replaceAll(from, to));
    }
  }
}

export function template(build: (dir: string) => unknown) {
  let ready: Promise<string> | undefined;
  const prepare = async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-template-"));
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    await build(dir);
    return dir;
  };
  return async (target: string) => {
    ready ??= prepare();
    const source = await ready;
    cpSync(source, target, { recursive: true, verbatimSymlinks: true });
    relocate(source, target);
    return target;
  };
}
