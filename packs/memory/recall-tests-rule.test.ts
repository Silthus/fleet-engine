import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit } from "../../src/testing/git.ts";
import { type Provider, bash, fire, fireInstalled, notes, recallHarness, shownLog } from "./recall-testing.ts";

isolateGit();
const { machineWithMemory } = recallHarness();

const guidePath = (home: string) => join(home, ".agents/guides/coding-standards.md");
const guide = "# Coding standards\n\n## Coding preferences\n\n- Keep it small.\n\n## Tests\n\n- Drive the real entry point.\n\n### Fakes\n\n- Fake only what you do not own.\n\n## Tech stack\n\n- Bun.\n";
const testsRule = "## Tests\n\n- Drive the real entry point.\n\n### Fakes\n\n- Fake only what you do not own.";
const write = (file_path: string, content = "test('x', () => {});\n") => ({ tool_name: "Write", tool_input: { file_path, content } });
const patch = (header: string) => ({ tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n${header}\n@@\n+test('x', () => {});\n*** End Patch\n` } });

async function machineWithGuide(text = guide) {
  const home = await machineWithMemory(notes);
  writeFileSync(guidePath(home), text);
  return home;
}

describe("the Tests rule before a test edit", () => {
  test("shows the installed guide's Tests section before the first test edit, and nothing before other edits", async () => {
    const home = await machineWithGuide();
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...write(join(home, "src/app.ts")) })).context).toBe("");
    const first = await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...write(join(home, "src/app.test.ts")) });
    expect(first.code).toBe(0);
    expect(first.context).toContain(`This call edits the test file ${join(home, "src/app.test.ts")}.`);
    expect(first.context).toContain(testsRule);
    expect(first.context).not.toContain("Tech stack");
    expect(first.context).not.toContain("Keep it small.");
  });

  test("shows the rule once per session and once per subagent", async () => {
    const home = await machineWithGuide();
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...write(join(home, "src/app.test.ts")) })).context).toContain(testsRule);
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...write(join(home, "tests/other.py")) })).context).toBe("");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", agent_id: "a1", cwd: home, ...write(join(home, "tests/other.py")) })).context).toContain(testsRule);
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", agent_id: "a1", cwd: home, ...write(join(home, "tests/third.py")) })).context).toBe("");
    expect(shownLog(home, "s1")).toEqual([
      expect.objectContaining({ session: "s1", via: "guide", note: "guides/coding-standards.md#tests", trigger: join(home, "src/app.test.ts") }),
      expect.objectContaining({ session: "s1", agent: "a1", via: "guide", note: "guides/coding-standards.md#tests", trigger: join(home, "tests/other.py") }),
    ]);
  });

  test.each(["Edit", "MultiEdit"])("shows the rule before a Claude Code %s of a test file", async (tool_name) => {
    const home = await machineWithGuide();
    const edit = { tool_name, tool_input: { file_path: "pkg/store_test.go", old_string: "a", new_string: "b" } };
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...edit })).context).toContain(testsRule);
  });

  test("shows the rule before a Codex patch that adds, updates, or moves to a test file", async () => {
    const home = await machineWithGuide();
    expect((await fire(home, "codex", "PreToolUse", { session_id: "s1", cwd: home, ...patch("*** Add File: src/app.ts") })).context).toBe("");
    expect((await fire(home, "codex", "PreToolUse", { session_id: "s1", cwd: home, ...patch("*** Update File: src/app.spec.tsx") })).context).toContain("This call edits the test file src/app.spec.tsx.");
    expect((await fire(home, "codex", "PreToolUse", { session_id: "s2", cwd: home, ...patch("*** Update File: src/old.ts\n*** Move to: src/__tests__/old.ts") })).context).toContain(testsRule);
    expect((await fire(home, "codex", "PreToolUse", { session_id: "s3", cwd: home, ...patch("*** Add File: tests/test_sync.py") })).context).toContain(testsRule);
  });

  test("ignores a shell call that only names a test file or prints a patch header, and still shows the rule at the first test edit", async () => {
    const home = await machineWithGuide();
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...bash("bun test src/app.test.ts") })).context).toBe("");
    expect((await fire(home, "codex", "PreToolUse", { session_id: "s1", cwd: home, ...bash("cat <<'PATCH'\n*** Add File: src/example.test.ts\nPATCH") })).context).toBe("");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...write("src/app.test.ts") })).context).toContain(testsRule);
  });

  test("shows the rule for a test file whose text names the memory folder, and shows it before the notes the call names", async () => {
    const home = await machineWithGuide();
    const memoryTest = write("packs/memory/recall.test.ts", "const root = '~/.agents/memory';\n");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...memoryTest })).context).toContain(testsRule);
    const both = await fire(home, "claude", "PreToolUse", { session_id: "s2", cwd: home, ...write("e2e/proof.test.ts", "// fleet proof 12\n") });
    expect(both.context.indexOf(testsRule)).toBeGreaterThanOrEqual(0);
    expect(both.context.indexOf(testsRule)).toBeLessThan(both.context.indexOf("Pass full SHAs"));
  });

  test.each<Provider>(["claude", "codex"])("adds nothing on %s while the guide or its Tests section is missing, and shows the rule once it is there", async (provider) => {
    const home = await machineWithGuide("# Coding standards\n\n## Coding preferences\n\n- Keep it small.\n");
    const call = provider === "claude" ? write("src/app.test.ts") : patch("*** Add File: src/app.test.ts");
    expect(await fire(home, provider, "PreToolUse", { session_id: "s1", cwd: home, ...call })).toEqual({ code: 0, stderr: "", context: "" });
    writeFileSync(guidePath(home), "# Coding standards\n\n## Tests\n\n");
    expect(await fire(home, provider, "PreToolUse", { session_id: "s1", cwd: home, ...call })).toEqual({ code: 0, stderr: "", context: "" });
    rmSync(guidePath(home));
    expect(await fire(home, provider, "PreToolUse", { session_id: "s1", cwd: home, ...call })).toEqual({ code: 0, stderr: "", context: "" });
    writeFileSync(guidePath(home), guide);
    expect((await fire(home, provider, "PreToolUse", { session_id: "s1", cwd: home, ...call })).context).toContain(testsRule);
  });

  test("shows the rule for a singular test folder", async () => {
    const home = await machineWithGuide();
    expect((await fireInstalled(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...write("test/helpers.ts") })).context).toContain(testsRule);
  });

  test("skips a Tests heading inside a code fence, and ends the section at the next level-one or level-two heading", async () => {
    const fenced = "# Coding standards\n\n## Examples\n\n```md\n## Tests\n\n- Fenced example.\n```\n\n## Tests\n\n- Drive the real entry point.\n\n```md\n## Not a heading\n```\n\n#\tAppendix\n\n- Leaked.\n";
    const home = await machineWithGuide(fenced);
    const shown = (await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...write("src/app.test.ts") })).context;
    expect(shown).toEndWith(":\n\n## Tests\n\n- Drive the real entry point.\n\n```md\n## Not a heading\n```");
    writeFileSync(guidePath(home), "## Examples\n\n```inline``` code, not a fence.\n\n## Tests\n\n- Drive the real entry point.\n\n##\tTech stack\n\n- Bun.\n");
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s2", cwd: home, ...write("src/app.test.ts") })).context).toEndWith(":\n\n## Tests\n\n- Drive the real entry point.");
  });

  test("still shows the rule when the memory folder cannot be read, and only once", async () => {
    const home = await machineWithGuide();
    const locked = join(home, ".agents/memory/locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const call = { session_id: "s1", cwd: home, ...write("src/app.test.ts", "// fleet proof 12\n") };
      const first = await fire(home, "claude", "PreToolUse", call);
      expect(first.code).toBe(0);
      expect(first.context).toContain(testsRule);
      expect((await fire(home, "claude", "PreToolUse", call)).context).toBe("");
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("shows the Tests section of the guide the base pack ships", async () => {
    const home = await machineWithMemory(notes);
    expect((await fire(home, "claude", "PreToolUse", { session_id: "s1", cwd: home, ...write("src/app.test.ts") })).context).toMatch(/:\n\n## Tests\n\n\S[^#]+$/);
  });
});
