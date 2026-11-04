import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

function scan(dir: string, base: string, list: string | null = denylist, stdin?: string, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...gitEnv(), FLEET_PRIVACY_DENYLIST: list ?? undefined, ...extraEnv };
  if (list === null) delete env.FLEET_PRIVACY_DENYLIST;
  const result = Bun.spawnSync(["sh", script, base], { cwd: dir, env, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(output.toLowerCase()).not.toContain(plantedTerm);
  return { code: result.exitCode, output };
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

  test("fails closed on an invalid pattern, even after a valid one", () => {
    const { dir, base } = repoWithBase();
    commit(dir, "notes.md", `ssh ${plantedTerm}\n`);
    const result = scan(dir, base, `${plantedTerm}\n[\n`);
    expect(result).toMatchObject({ code: 2, output: expect.stringContaining("invalid pattern") });
  });

  test("fails on a term that a later commit deletes or cleans", () => {
    const { dir, base } = repoWithBase();
    commit(dir, "gone.md", `ssh ${plantedTerm}\n`);
    commit(dir, "cleaned.md", `scp ${plantedTerm}\n`);
    unlinkSync(join(dir, "gone.md"));
    commit(dir, "cleaned.md", "clean\n");
    const result = scan(dir, base);
    expect(result.code).toBe(1);
    expect(result.output.match(/matches a deny-list term/g)?.length).toBe(2);
  });

  test("fails on a secret that only a merge resolution adds", () => {
    const { dir, base } = repoWithBase();
    git(dir, "checkout", "-q", "-b", "side");
    commit(dir, "config.ts", "export const token = 'side';\n");
    git(dir, "checkout", "-q", "main");
    commit(dir, "config.ts", "export const token = 'main';\n");
    Bun.spawnSync(["git", "merge", "-q", "side"], { cwd: dir, env: gitEnv() });
    const token = fakeGitHubToken();
    commit(dir, "config.ts", `export const token = "${token}";\n`, "Merge side");
    const result = scan(dir, base);
    expect(git(dir, "rev-list", "--merges", "--count", "HEAD")).toBe("1");
    expect(result.code).toBe(1);
    expect(result.output).toContain("gitleaks rule");
    expect(result.output).not.toContain(token);
  });

  test("fails on a path that names a term, without printing the path", () => {
    const { dir, base } = repoWithBase();
    commit(dir, `${plantedTerm}.md`, "clean\n");
    const result = scan(dir, base);
    expect(result).toMatchObject({ code: 1, output: expect.stringContaining("1 changed path(s)") });
  });

  test("reads binary files and symlink targets from Git", () => {
    const { dir, base } = repoWithBase();
    const token = fakeGitHubToken();
    commit(dir, "data.bin", `\0\0ssh ${plantedTerm}\0 "${token}"\n`);
    symlinkSync(`/srv/${plantedTerm}/x`, join(dir, "link"));
    commit(dir, "README.md", "# Example\n");
    const result = scan(dir, base);
    expect(result.code).toBe(1);
    expect(result.output.match(/matches a deny-list term/g)?.length).toBe(2);
    expect(result.output).toContain("gitleaks rule");
    expect(result.output).not.toContain(token);
  });

  test("--all scans the root commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "privacy-scan-"));
    repos.push(dir);
    git(dir, "init", "-q", "-b", "main");
    const token = fakeGitHubToken();
    commit(dir, "notes.md", `ssh ${plantedTerm}\n"${token}"\n`);
    const result = scan(dir, "--all");
    expect(result.code).toBe(1);
    expect(result.output).toContain("matches a deny-list term");
    expect(result.output).toContain("gitleaks rule");
  });

  test("--text scans a pull request title and body", () => {
    const { dir } = repoWithBase();
    expect(scan(dir, "--text", denylist, "Clean title\nClean body\n").code).toBe(0);
    expect(scan(dir, "--text", denylist, `Title\nSee ${plantedTerm.toUpperCase()}\n`)).toMatchObject({ code: 1, output: expect.stringContaining("the pull request title or body, line 2") });
  });

  test("fails on a planted deny-list term without printing the term", () => {
    const { dir, base } = repoWithBase();
    commit(dir, "notes.md", `line one\nssh ${plantedTerm.toUpperCase()}\n`);
    const result = scan(dir, base);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(`blob ${git(dir, "rev-parse", "HEAD:notes.md")}`);
    expect(result.output).toContain("line 2");
    expect(result.output).not.toContain("notes.md");
  });

  test("fails on a deny-list term in a commit message", () => {
    const { dir, base } = repoWithBase();
    commit(dir, "notes.md", "Nothing private here.\n", `Move ${plantedTerm}`);
    const result = scan(dir, base);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("message of commit");
  });

  test("fails on a planted fake secret without printing it", () => {
    const { dir, base } = repoWithBase();
    const token = fakeGitHubToken();
    commit(dir, "config.ts", `export const token = "${token}";\n`);
    const result = scan(dir, base);
    expect(result.code).not.toBe(0);
    expect(result.output).not.toContain(token);
  });

  test("finds a secret in a recognized binary file, across a 10,000-byte chunk boundary, and in a file name", () => {
    const wrappers: Array<[string, string]> = [
      ["doc.pdf", "%PDF-1.4\n"],
      ["long.txt", "x".repeat(9980)],
    ];
    for (const [name, before] of wrappers) {
      const { dir, base } = repoWithBase();
      const secret = fakeGitHubToken();
      commit(dir, name, `${before}"${secret}"\n`);
      const result = scan(dir, base);
      expect(result.code).toBe(1);
      expect(result.output).toContain("gitleaks rule");
      expect(result.output.includes(secret)).toBe(false);
    }
    const { dir, base } = repoWithBase();
    const token = fakeGitHubToken();
    commit(dir, token, "clean\n");
    const result = scan(dir, base);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/gitleaks rule \S+ matched paths-[0-9a-f]{40}, line 1\./);
    expect(result.output.includes(token)).toBe(false);
  });

  test("fails closed when reading the deny-list fails, and prints no tool errors", () => {
    const { dir, base } = repoWithBase();
    commit(dir, "notes.md", "other-private-repo\n");
    const shims = mkdtempSync(join(tmpdir(), "privacy-shims-"));
    repos.push(shims);
    writeFileSync(join(shims, "grep"), `#!/bin/sh\nif [ "$1" = -v ]; then ${Bun.which("grep")} "$@" | head -n 1; exit 2; fi\nexec ${Bun.which("grep")} "$@"\n`);
    chmodSync(join(shims, "grep"), 0o755);
    const truncated = scan(dir, base, `${plantedTerm}\nother-private-repo\n`, undefined, { PATH: `${shims}:${process.env.PATH}` });
    expect(truncated).toMatchObject({ code: 2, output: expect.stringContaining("could not read the deny-list") });

    const tmp = join(shims, `tmp-${plantedTerm}`);
    mkdirSync(tmp);
    const invalid = scan(dir, base, "[\n", undefined, { TMPDIR: tmp });
    expect(invalid).toMatchObject({ code: 2, output: "privacy: the deny-list holds an invalid pattern; failing closed.\n" });
  });
});
