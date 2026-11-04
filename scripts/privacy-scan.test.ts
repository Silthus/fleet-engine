import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "privacy-scan.sh");
const plantedTerm = "acme-secret-host";
const denylist = `# comment line\n\n${plantedTerm}\nother-private-repo\n`;
const repos: string[] = [];

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, env: gitEnv() });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

function repoWithBase() {
  const dir = mkdtempSync(join(tmpdir(), "privacy-scan-"));
  repos.push(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# Example\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Start");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

function commit(dir: string, file: string, content: string, message = "Change") {
  writeFileSync(join(dir, file), content);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", message);
}

function scan(dir: string, base: string, list: string | null = denylist) {
  const env: Record<string, string | undefined> = { ...gitEnv(), FLEET_PRIVACY_DENYLIST: list ?? undefined };
  if (list === null) delete env.FLEET_PRIVACY_DENYLIST;
  const result = Bun.spawnSync(["sh", script, base], { cwd: dir, env });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

function fakeGitHubToken() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return "ghp_" + [...randomBytes(36)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

describe("privacy scan", () => {
  test("passes a clean diff", () => {
    const { dir, base } = repoWithBase();
    commit(dir, "notes.md", "Nothing private here.\n");
    expect(scan(dir, base)).toMatchObject({ code: 0 });
  });

  test("fails closed when the deny-list is missing or empty", () => {
    const { dir, base } = repoWithBase();
    commit(dir, "notes.md", "Nothing private here.\n");
    for (const list of [null, "", "# only a comment\n"]) {
      const result = scan(dir, base, list);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("failing closed");
    }
  });

  test("fails on a planted deny-list term without printing the term", () => {
    const { dir, base } = repoWithBase();
    commit(dir, "notes.md", `line one\nssh ${plantedTerm.toUpperCase()}\n`);
    const result = scan(dir, base);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("notes.md:2");
    expect(result.output.toLowerCase()).not.toContain(plantedTerm);
  });

  test("fails on a deny-list term in a commit message", () => {
    const { dir, base } = repoWithBase();
    commit(dir, "notes.md", "Nothing private here.\n", `Move ${plantedTerm}`);
    const result = scan(dir, base);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("commit message");
  });

  test("fails on a planted fake secret without printing it", () => {
    const { dir, base } = repoWithBase();
    const token = fakeGitHubToken();
    commit(dir, "config.ts", `export const token = "${token}";\n`);
    const result = scan(dir, base);
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain(token);
  });
});
