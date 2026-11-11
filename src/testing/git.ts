import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

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

type Entry = { path: string } & ({ kind: "dir" } | { kind: "link"; target: string } | { kind: "file"; mode: number; data: Buffer });

const pathFiles = new Set(["config", "gitdir", ".git"]);

function snapshot(root: string, dir = root, entries: Entry[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const at = relative(root, path);
    if (entry.isSymbolicLink()) entries.push({ path: at, kind: "link", target: readlinkSync(path) });
    else if (entry.isDirectory()) {
      entries.push({ path: at, kind: "dir" });
      snapshot(root, path, entries);
    } else entries.push({ path: at, kind: "file", mode: statSync(path).mode, data: readFileSync(path) });
  }
  return entries;
}

function restore(entries: Entry[], from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const entry of entries) {
    const path = join(to, entry.path);
    if (entry.kind === "dir") mkdirSync(path, { recursive: true });
    else if (entry.kind === "link") symlinkSync(entry.target.startsWith(from) ? to + entry.target.slice(from.length) : entry.target, path);
    else writeFileSync(path, pathFiles.has(basename(path)) ? entry.data.toString().replaceAll(from, to) : entry.data, { mode: entry.mode });
  }
}

export function template(build: (dir: string) => unknown) {
  let ready: Promise<{ from: string; entries: Entry[] }> | undefined;
  const prepare = async () => {
    const from = mkdtempSync(join(tmpdir(), "fleet-template-"));
    try {
      await build(from);
      return { from, entries: snapshot(from) };
    } finally {
      rmSync(from, { recursive: true, force: true });
    }
  };
  return async (target: string) => {
    ready ??= prepare();
    const { from, entries } = await ready;
    restore(entries, from, target);
    return target;
  };
}
