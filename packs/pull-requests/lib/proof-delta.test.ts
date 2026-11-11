import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { onlyCommentsChanged } from "./proof-delta.ts";
import { cleanFixtures, fixture } from "./proof-testing.ts";

afterEach(cleanFixtures);

async function quiet(path: string, before: string, after: string) {
  const directory = fixture("fleet-proof-delta-");
  writeFileSync(join(directory, "before"), before);
  writeFileSync(join(directory, "after"), after);
  const child = Bun.spawn(["git", "diff", "--no-index", "-U0", "before", "after"], { cwd: directory, stdout: "pipe" });
  return onlyCommentsChanged(path, before, after, await new Response(child.stdout).text());
}

test("comment and blank lines are quiet in TS, JS, Go, and Python, and code that only looks like a comment is not", async () => {
  expect(await quiet("app.py", "def run():\n    return 1\n", "# Runs once.\ndef run():\n\n    return 1\n")).toBe(true);
  expect(await quiet("app.py", 'def run():\n    """Runs."""\n', 'def run():\n    """Runs once."""\n')).toBe(false);
  expect(await quiet("app.py", 'text = """\n# one\n"""\n', 'text = """\n# two\n"""\n')).toBe(false);
  expect(await quiet("main.go", "package main\n\n/* one */\nvar x = 1\n", "package main\n\n/* two\n   lines */\nvar x = 1\n")).toBe(true);
  expect(await quiet("main.go", "var x = `\n// one\n`\n", "var x = `\n// two\n`\n")).toBe(false);
  expect(await quiet("app.js", "const r = /[/*]/;\nconst x = 1;\n", "const r = /[/*]/;\nconst x = 2;\n")).toBe(false);
  expect(await quiet("app.js", "const r = x.split(/,/);\n", "const r = x.split(/,/);\n// split\n")).toBe(true);
  expect(await quiet("app.ts", "const s = `${a}\n// one\n`;\n", "const s = `${a}\n// two\n`;\n")).toBe(false);
  expect(await quiet("app.ts", "const a = `${{ b: 1 }.b\n// one\n}`;\n", "const a = `${{ b: 1 }.b\n// two\n}`;\n")).toBe(true);
  expect(await quiet("app.rb", "x = 1\n", "# note\nx = 1\n")).toBe(false);
});
