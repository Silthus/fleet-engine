import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableSource } from "../../../src/pack/types.ts";
import { spawnGit, tempDirs } from "../../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../../src/testing/packs.ts";
import { formatCommands, formatEditedFile, type RunCommand } from "../lib/format-commands.ts";
import { budgetMs, formatAfterEdit, hook } from "./format-on-edit.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const root = "/repo";
const config = {
  "*.{md,mdx}": "prettier --write",
  "web/**/*.{ts,tsx}": ["biome check --write", "eslint --fix"],
  "*.py": ["ruff check --fix", "ruff format", "black", "uv run --no-sync ty check"],
  "!(generated/*)*.rs": "rustfmt",
  "scripts/*.sh": "git add --chmod=+x",
  "web/**/manifest.tsx": ["prettier --write", "sh -c 'pnpm build && git add web/index.tsx'"],
  "*.json": ["prettier --write", "prettier --write $(pwd)", "prettier --write | tee log", "biome format --write > log"],
  "*.go": ["gofmt -w", "/tmp/elsewhere/gofmt -w", "./gofmt -w"],
  "*.toml": ["bunx evil-pkg --fix", "npx prettier --write", "pnpm dlx evil --write", "yarn dlx evil --write", "uvx ruff format", "pipx run black"],
  "*.js": ["node scripts/format.js", "rm -rf format /x", "sh -c format", "bash -c format", "python3 -m black", "bin/tool format:js", "pnpm format", "bun run format"],
  "*.css": 7,
};
const installed = async (name: string) => `/bin/${name}`;
const commandsFor = (path: string) => formatCommands(config, root, `${root}/${path}`, installed);
const commandsAt = async (path: string) => (await commandsFor(path)).map((command) => command.slice(0, -1).join(" "));

describe("the lint-staged commands for an edited file", () => {
  test("are the repository's formatter commands, matched as lint-staged matches, resolved to the installed formatter, with the file last", async () => {
    expect(await commandsFor("docs/guide.md")).toEqual([["/bin/prettier", "--write", "/repo/docs/guide.md"]]);
    expect(await commandsAt("backend/models.py")).toEqual(["/bin/ruff check --fix", "/bin/ruff format", "/bin/black"]);
    expect(await commandsAt("web/app/run.ts")).toEqual(["/bin/biome check --write", "/bin/eslint --fix"]);
    expect(await commandsAt("web/app/manifest.tsx")).toEqual(["/bin/biome check --write", "/bin/eslint --fix", "/bin/prettier --write"]);
    expect(await commandsAt("src/main.go")).toEqual(["/bin/gofmt -w"]);
  });

  test.each([
    ["a shell snippet", "web/app/manifest.tsx", ["/bin/biome check --write", "/bin/eslint --fix", "/bin/prettier --write"]],
    ["a Git command", "scripts/setup.sh", []],
    ["a pipe, a redirect or a substitution", "data.json", ["/bin/prettier --write"]],
    ["a formatter named by a path", "src/main.go", ["/bin/gofmt -w"]],
    ["a package runner", "Cargo.toml", []],
    ["an interpreter, a shell, a script or any other program", "app.js", []],
    ["a negated pattern", "src/main.rs", []],
    ["a value that is no command", "site.css", []],
    ["a file no pattern names", "web/app.rb", []],
  ])("leave out %s", async (_, path, kept) => {
    expect(await commandsAt(path)).toEqual(kept);
  });

  test("leave out a formatter that is not installed", async () => {
    expect(await formatCommands({ "*.md": "prettier --write" }, root, `${root}/a.md`, async () => undefined)).toEqual([]);
  });

  test("run in order, stop when the time budget is spent, and keep each failure", async () => {
    const repo = await repository({ "lint-staged": { "*.ts": ["prettier --write", "eslint --fix", "biome check --write"] } });
    let clock = 0;
    const ran: string[] = [];
    const run: RunCommand = async (command, _cwd, timeoutMs) => {
      ran.push(`${command[0]} ${timeoutMs}`);
      clock += 40;
      return command[0] === "/bin/prettier" ? "prettier failed" : undefined;
    };
    expect(await formatEditedFile(join(repo, "src/x.ts"), run, 70, () => clock, installed)).toEqual(["prettier failed"]);
    expect(ran).toEqual(["/bin/prettier 70", "/bin/eslint 30"]);
  });
});

async function repository(packageJson?: object, rc?: object) {
  const repo = temp.make("repo-");
  await spawnGit(repo, "init", "-q");
  mkdirSync(join(repo, "src"));
  if (packageJson) writeFileSync(join(repo, "package.json"), JSON.stringify(packageJson));
  if (rc) writeFileSync(join(repo, ".lintstagedrc.json"), JSON.stringify(rc));
  return repo;
}

function tool(repo: string, name: string, script: string) {
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(repo, "node_modules/.bin", name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

describe("the format-on-edit hook", () => {
  test("lets the repository's formatter rewrite the file Claude edited, and stays quiet", async () => {
    const repo = await repository(undefined, { "*.ts": "prettier --write" });
    tool(repo, "prettier", 'printf "formatted\\n" > "$2"');
    const file = join(repo, "src/x.ts");
    writeFileSync(file, "messy");
    expect(await hook("claude", async () => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } }), repo)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(file, "utf8")).toBe("formatted\n");
  });

  test("hands Claude what a fixer could not fix as context, from a repo config in package.json", async () => {
    const repo = await repository({ "lint-staged": { "*.ts": "eslint --fix" } });
    tool(repo, "eslint", 'echo "x.ts:1 unused variable" >&2; exit 1');
    const file = join(repo, "src/x.ts");
    writeFileSync(file, "let a");
    const result = await hook("claude", async () => JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } }), repo);
    expect(result.code).toBe(0);
    const context = JSON.parse(result.stdout).hookSpecificOutput;
    expect(context.hookEventName).toBe("PostToolUse");
    expect(context.additionalContext).toContain(`found problems in ${file}`);
    expect(context.additionalContext).toContain("x.ts:1 unused variable");
  });

  test("formats each file a Codex patch adds, updates or moves, a move at its destination, and hands Codex the findings as context", async () => {
    const repo = await repository(undefined, { "*.ts": "prettier --write" });
    tool(repo, "prettier", 'case "$2" in *broken.ts) echo "broken.ts:1 syntax error" >&2; exit 1;; esac; printf "formatted\\n" > "$2"');
    for (const name of ["kept.ts", "broken.ts", "moved-to.ts"]) writeFileSync(join(repo, "src", name), "messy");
    writeFileSync(join(repo, "src/added.ts"), "messy");
    const patch = [
      "*** Begin Patch", "*** Add File: src/added.ts", "+messy", "*** Update File: src/kept.ts", "@@", "-old", "+messy",
      "*** Update File: src/broken.ts", "@@", "-old", "+messy", "*** Update File: src/moved-from.ts", "*** Move to: src/moved-to.ts", "@@", "-old", "+messy",
      "*** Delete File: src/gone.ts", "*** End Patch",
    ].join("\n");
    const result = await hook("codex", async () => JSON.stringify({ tool_name: "apply_patch", cwd: repo, tool_input: { command: patch } }), repo);
    for (const name of ["added.ts", "kept.ts", "moved-to.ts"]) expect(readFileSync(join(repo, "src", name), "utf8")).toBe("formatted\n");
    expect(existsSync(join(repo, "src/moved-from.ts"))).toBe(false);
    expect(existsSync(join(repo, "src/gone.ts"))).toBe(false);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("broken.ts:1 syntax error");
  });

  test("still formats a patch's other files when one file's formatter cannot start", async () => {
    const repo = await repository(undefined, { "*.ts": "prettier --write" });
    tool(repo, "prettier", 'printf "formatted\\n" > "$2"');
    writeFileSync(join(repo, "src/good.ts"), "messy");
    const patch = ["*** Begin Patch", "*** Update File: src/missing-dir/bad.ts", "@@", "+x", "*** Update File: src/good.ts", "@@", "+x", "*** End Patch"].join("\n");
    await hook("codex", async () => JSON.stringify({ tool_name: "apply_patch", cwd: repo, tool_input: { command: patch } }), repo);
    expect(readFileSync(join(repo, "src/good.ts"), "utf8")).toBe("formatted\n");
  });

  test("ignores a formatter whose shell says a tool it needs is not found", async () => {
    const repo = await repository(undefined, { "*.ts": "prettier --write" });
    tool(repo, "prettier", 'echo "prettier: node: command not found" >&2; exit 1');
    const file = join(repo, "src/x.ts");
    writeFileSync(file, "x");
    expect(await formatAfterEdit({ tool_name: "Edit", tool_input: { file_path: file } })).toBeUndefined();
  });

  test("never runs a package runner or a program that is no formatter, even one the repository ships", async () => {
    const repo = await repository(undefined, { "*.ts": ["bunx evil-pkg --fix", "node_modules/.bin/evil --fix", "evil --fix"] });
    tool(repo, "bunx", "touch \"$0.ran\"");
    tool(repo, "evil", "touch \"$0.ran\"");
    const file = join(repo, "src/x.ts");
    writeFileSync(file, "x");
    expect(await hook("claude", async () => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } }), repo)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(join(repo, "node_modules/.bin/bunx.ran"))).toBe(false);
    expect(existsSync(join(repo, "node_modules/.bin/evil.ran"))).toBe(false);
  });

  test("never runs a formatter binary the repository commits to Git", async () => {
    const repo = await repository(undefined, { "*.ts": "prettier --write" });
    tool(repo, "prettier", "touch \"$0.ran\"");
    await spawnGit(repo, "add", "-f", "node_modules/.bin/prettier");
    const file = join(repo, "src/x.ts");
    writeFileSync(file, "x");
    expect(await formatAfterEdit({ tool_name: "Edit", tool_input: { file_path: file } })).toBeUndefined();
    expect(existsSync(join(repo, "node_modules/.bin/prettier.ran"))).toBe(false);
  });

  test.each([
    ["a Bash call", { tool_name: "Bash", tool_input: { command: "ls" } }],
    ["a relative path", { tool_name: "Edit", tool_input: { file_path: "src/x.ts" } }],
    ["a file outside any repository", { tool_name: "Edit", tool_input: { file_path: "/x.ts" } }],
  ])("does nothing for %s", async (_, event) => {
    let ran = false;
    expect(await formatAfterEdit(event, async () => ((ran = true), "failed"))).toBeUndefined();
    expect(ran).toBe(false);
  });

  test("stays quiet for input that is not JSON", async () => {
    expect(await hook("claude", async () => "not json", "/")).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("is off by default, and once turned on installs for a Claude, a Codex or a both plan, with a PostToolUse timeout that fits its budget", () => {
    const target = ".config/fleet/hooks/PostToolUse/format-on-edit.ts";
    const resolved = (workflows: Record<string, boolean>, aiPlan: "claude" | "codex" | "both") => resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { workflows, plan: aiPlan }, devbox);
    expect(resolved({}, "claude").files.map((file) => file.target)).not.toContain(target);
    for (const aiPlan of ["claude", "codex", "both"] as const) expect(resolved({ "format-on-edit": true }, aiPlan).files.map((file) => file.target)).toContain(target);
    const postToolUse = resolved({ "format-on-edit": true }, "codex").config.find((entry) => entry.provider === "codex" && entry.key === "hooks.PostToolUse");
    const timeouts = (postToolUse?.value as { hooks: { timeout: number }[] }[]).flatMap((group) => group.hooks.map((handler) => handler.timeout * 1000));
    expect(Math.min(...timeouts)).toBeGreaterThan(budgetMs);
  });
});
