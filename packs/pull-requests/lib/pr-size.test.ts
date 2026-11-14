import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitEnv, spawnGit, tempDirs } from "../../../src/testing/git.ts";
import { spawnAsync } from "../../../src/testing/spawn.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const command = join(import.meta.dir, "..", "commands", "pr.ts");

async function branch(base: Record<string, string>, change: Record<string, string>) {
  const repo = temp.make("fleet-pr-size-");
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  };
  await spawnGit(repo, "init", "-q", "-b", "main");
  write(base);
  await spawnGit(repo, "add", ".");
  await spawnGit(repo, "commit", "-qm", "base");
  await spawnGit(repo, "checkout", "-qb", "work");
  write(change);
  await spawnGit(repo, "add", ".");
  await spawnGit(repo, "commit", "-qm", "work");
  return async (...args: string[]) => {
    const result = await spawnAsync([process.execPath, command, "size", "--base", "main", ...args], { cwd: repo, env: { ...gitEnv, FLEET_HANDLERS: "{}" } });
    return { code: result.exitCode, out: result.stdout.trim() };
  };
}

const lines = (count: number, line: string) => Array.from({ length: count }, (_, n) => `${line} ${n}`).join("\n") + "\n";

test("counts authored lines without tests or lockfiles and runs the delete pass over 1.5 times the estimate", async () => {
  const size = await branch({ "src/old.ts": "export {};\n" }, {
    "src/a.ts": lines(10, "// a"),
    "src/a.test.ts": lines(50, "// test"),
    "bun.lock": lines(40, "lock"),
  });

  expect(await size("--lines", "7")).toEqual({ code: 0, out: "size: 10 authored lines, 1 new file (src/a.ts), 0 new concepts\nwithin the estimate of 7 lines" });
  expect(await size("--lines", "6")).toEqual({ code: 1, out: "size: 10 authored lines, 1 new file (src/a.ts), 0 new concepts\nover 1.5 times the estimate of 6 lines: run the delete pass" });
});

test("counts flags, env vars and config keys the base does not name yet", async () => {
  const size = await branch({ "src/old.ts": "const old = process.env.OLD_VAR;\n", "config.json": "{\n  \"oldKey\": 1\n}\n" }, {
    "src/old.ts": [
      "const old = process.env.OLD_VAR;",
      "const fresh = Bun.env.NEW_VAR ?? os.environ.get(\"PY_VAR\");",
      "const flag = args.includes(\"--fresh-flag\") && isFeatureEnabled(\"new-rollout\");",
    ].join("\n") + "\n",
    "config.json": "{\n  \"oldKey\": 1,\n  \"newKey\": 2\n}\n",
    "README.md": "Run it with `--doc-only-flag` and FOO_VAR.\n",
  });

  const summary = "size: 5 authored lines, 1 new file (README.md), 5 new concepts (newKey, NEW_VAR, PY_VAR, --fresh-flag, new-rollout)";
  expect(await size("--lines", "100", "--concepts", "5")).toEqual({ code: 0, out: `${summary}\nwithin the estimate of 100 lines and 5 concepts` });
  expect(await size("--lines", "100", "--concepts", "3")).toEqual({ code: 1, out: `${summary}\nover 1.5 times the estimate of 100 lines and 3 concepts: run the delete pass` });
});

test("compares nothing without an estimate", async () => {
  const size = await branch({ "src/old.ts": "export {};\n" }, { "src/a.ts": lines(500, "// a") });

  expect(await size()).toEqual({ code: 0, out: "size: 500 authored lines, 1 new file (src/a.ts), 0 new concepts\nno estimate: the size contract did not run" });
});

test("refuses a missing base or a count that is not a number", async () => {
  const refused = await spawnAsync([process.execPath, command, "size"], { cwd: temp.make(), env: { ...gitEnv, FLEET_HANDLERS: "{}" } });

  expect(refused.stderr).toContain("Usage: fleet pr size --base <ref> [--lines <n>] [--concepts <n>]");
  const notANumber = await spawnAsync([process.execPath, command, "size", "--base", "main", "--lines", "many"], { cwd: temp.make(), env: { ...gitEnv, FLEET_HANDLERS: "{}" } });

  expect(notANumber.exitCode).toBe(1);
  expect(notANumber.stderr).toContain("Usage: fleet pr size");
});
