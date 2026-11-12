import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableSource } from "../../../src/pack/types.ts";
import { tempDirs } from "../../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../../src/testing/packs.ts";
import { formatCommands, formatEditedFile, type RunCommand } from "../lib/format-commands.ts";
import { formatAfterEdit, hook } from "./format-on-edit.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const root = "/repo";
const config = {
  "*.{md,mdx}": "bin/tool format:markdown",
  "web/**/*.{ts,tsx}": "bin/tool format:js",
  "*.py": ["bin/tool lint:python:fix", "bin/tool format:python", "uv run --no-sync ty check"],
  "packages/agent/**/*.ts": "pnpm --dir packages/agent exec biome check --write",
  "!(generated/*)*.rs": "cargo fmt --write",
  "scripts/*.sh": "git add --chmod=+x",
  "web/**/manifest.tsx": ["bin/tool format:js", "sh -c 'pnpm build && git add web/index.tsx'"],
  "*.json": ["prettier --write", "bin/tool fix:json $(pwd)", "bin/tool format:json | tee log", "bin/tool format:json > log", "/usr/bin/git hook run --fix"],
  "*.css": 7,
};
const commandsFor = (path: string) => formatCommands(config, root, `${root}/${path}`);

describe("the lint-staged commands for an edited file", () => {
  test("are the repository's commands that rewrite the file, matched as lint-staged matches, with the file last", () => {
    expect(commandsFor("docs/guide.md")).toEqual([["bin/tool", "format:markdown", "/repo/docs/guide.md"]]);
    expect(commandsFor("backend/models.py")).toEqual([
      ["bin/tool", "lint:python:fix", "/repo/backend/models.py"],
      ["bin/tool", "format:python", "/repo/backend/models.py"],
    ]);
    expect(commandsFor("packages/agent/src/run.ts")).toEqual([
      ["pnpm", "--dir", "packages/agent", "exec", "biome", "check", "--write", "/repo/packages/agent/src/run.ts"],
    ]);
    expect(commandsFor("web/app/manifest.tsx")).toEqual([["bin/tool", "format:js", "/repo/web/app/manifest.tsx"]]);
  });

  test.each([
    ["a shell snippet", "web/app/manifest.tsx", ["bin/tool format:js"]],
    ["a Git command", "scripts/setup.sh", []],
    ["a pipe, a redirect, a substitution or a Git path", "data.json", ["prettier --write"]],
    ["a negated pattern", "src/main.rs", []],
    ["a value that is no command", "site.css", []],
    ["a file no pattern names", "web/app.go", []],
  ])("leave out %s", (_, path, kept) => {
    expect(commandsFor(path).map((command) => command.slice(0, -1).join(" "))).toEqual(kept);
  });

  test("run in order, stop when the time budget is spent, and keep each failure", async () => {
    const repo = repository({ "lint-staged": { "*.ts": ["bin/a --fix", "bin/b --write", "bin/c --write"] } });
    let clock = 0;
    const ran: string[] = [];
    const run: RunCommand = async (command, _cwd, timeoutMs) => {
      ran.push(`${command[0]} ${timeoutMs}`);
      clock += 40;
      return command[0] === "bin/a" ? "a failed" : undefined;
    };
    expect(await formatEditedFile(join(repo, "src/x.ts"), run, 70, () => clock)).toEqual(["a failed"]);
    expect(ran).toEqual(["bin/a 70", "bin/b 30"]);
  });
});

function repository(packageJson?: object, rc?: object) {
  const repo = temp.make("repo-");
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "src"));
  if (packageJson) writeFileSync(join(repo, "package.json"), JSON.stringify(packageJson));
  if (rc) writeFileSync(join(repo, ".lintstagedrc.json"), JSON.stringify(rc));
  return repo;
}

function tool(name: string, script: string) {
  const path = join(temp.make("bin-"), name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
}

describe("the format-on-edit hook", () => {
  test("lets the repository's formatter rewrite the file Claude edited, and stays quiet", async () => {
    const formatter = tool("fmt", 'printf "formatted\\n" > "$2"');
    const repo = repository(undefined, { "*.ts": `${formatter} --write` });
    const file = join(repo, "src/x.ts");
    writeFileSync(file, "messy");
    expect(await hook("claude", async () => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } }), repo)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(readFileSync(file, "utf8")).toBe("formatted\n");
  });

  test("hands Claude what a fixer could not fix, from a repo config in package.json", async () => {
    const fixer = tool("lint", 'echo "x.ts:1 unused variable" >&2; exit 1');
    const repo = repository({ "lint-staged": { "*.ts": `${fixer} --fix` } });
    const file = join(repo, "src/x.ts");
    writeFileSync(file, "let a");
    const result = await hook("claude", async () => JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } }), repo);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`found problems in ${file}`);
    expect(result.stderr).toContain("x.ts:1 unused variable");
  });

  test.each([
    ["a tool that is not installed", "/nowhere/fmt --write"],
    ["a tool whose shell says it is not found", `${"TOOL"} --write`],
  ])("ignores %s", async (_, command) => {
    const missing = tool("fmt", 'echo "fmt: npx: command not found" >&2; exit 1');
    const repo = repository(undefined, { "*.ts": command.replace("TOOL", missing) });
    const file = join(repo, "src/x.ts");
    writeFileSync(file, "x");
    expect(await formatAfterEdit({ tool_name: "Edit", tool_input: { file_path: file } })).toBeUndefined();
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

  test("stays quiet for Codex and for input that is not JSON", async () => {
    expect(await hook("codex", async () => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/x.ts" } }), "/")).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await hook("claude", async () => "not json", "/")).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("is off by default, and installs for Claude only once turned on", () => {
    const target = ".config/fleet/hooks/PostToolUse/format-on-edit.ts";
    const plan = (workflows: Record<string, boolean>, aiPlan: "claude" | "codex") => resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { workflows, plan: aiPlan }, devbox).files.map((file) => file.target);
    expect(plan({}, "claude")).not.toContain(target);
    expect(plan({ "format-on-edit": true }, "claude")).toContain(target);
    expect(plan({ "format-on-edit": true }, "codex")).not.toContain(target);
  });
});
