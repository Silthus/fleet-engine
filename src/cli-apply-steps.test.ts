import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli.ts";
import { cliFixtures } from "./testing/cli.ts";
import { tempDirs } from "./testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const { profileDir, engineWithCommands } = cliFixtures(temp);

const shell = (script: string) => ["sh", "-c", script];
function engineWithTools() {
  const engine = engineWithCommands();
  const base = JSON.parse(readFileSync(join(engine, "packs/base/pack.json"), "utf8"));
  writeFileSync(join(engine, "packs/base/pack.json"), JSON.stringify({ ...base, steps: [] }));
  mkdirSync(join(engine, "packs/tools"), { recursive: true });
  const steps = [
    { id: "box", run: shell('touch "$HOME/box.txt"'), check: shell('test -f "$HOME/box.txt"'), undo: shell('rm -f "$HOME/box.txt"') },
    { id: "codex", run: shell('touch "$HOME/codex.txt"'), check: shell('test -f "$HOME/codex.txt"') },
  ];
  writeFileSync(join(engine, "packs/tools/pack.json"), JSON.stringify({ schema: 1, name: "tools", summary: "tools pack.", steps }));
  return engine;
}
const run = (args: string[], home: string, engine: string) =>
  main(args, { home, engineRoot: engine, platform: "linux", env: {}, print: () => {}, run: (command, env = {}) => Bun.spawn(command, { stdout: "ignore", stderr: "ignore", env: { ...Bun.env, HOME: home, ...env } }).exited });

describe("fleet apply --skip", () => {
  test("leaves the named step for a later apply, and never undoes a step it skips", async () => {
    const home = temp.make("home-");
    const engine = engineWithTools();
    const profile = profileDir(["tools"]);
    expect(await run(["apply", "--profile", profile, "--skip", "tools/codex"], home, engine)).toBe(0);
    expect(existsSync(join(home, "box.txt"))).toBe(true);
    expect(existsSync(join(home, "codex.txt"))).toBe(false);
    expect(await run(["apply", "--skip", "tools/box"], home, engine)).toBe(0);
    expect(existsSync(join(home, "box.txt"))).toBe(true);
    expect(existsSync(join(home, "codex.txt"))).toBe(true);
  });

  test("keeps a step it skips although its pack left the profile, so the next apply undoes it", async () => {
    const home = temp.make("home-");
    const engine = engineWithTools();
    const profile = profileDir(["tools"]);
    expect(await run(["apply", "--profile", profile], home, engine)).toBe(0);
    const file = JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8"));
    writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...file, packs: [] }));
    expect(await run(["apply", "--skip", "tools/box"], home, engine)).toBe(0);
    expect(existsSync(join(home, "box.txt"))).toBe(true);
    expect(await run(["apply"], home, engine)).toBe(0);
    expect(existsSync(join(home, "box.txt"))).toBe(false);
  });
});

describe("fleet apply progress", () => {
  test("names each step as it starts, before the step's own work ends, and stays quiet for a step that already holds", async () => {
    const home = temp.make("home-");
    const engine = engineWithTools();
    const profile = profileDir(["tools"]);
    const lines: string[] = [];
    const namedBeforeItsWork: Record<string, boolean> = {};
    const print = (line: string) => void lines.push(line);
    const runStep = async (command: string[], env: Record<string, string> = {}) => {
      const step = command.join(" ").match(/touch "\$HOME\/(\w+)\.txt"/)?.[1];
      if (step) namedBeforeItsWork[step] = lines.includes(`  … tools: ${step}`);
      return Bun.spawn(command, { stdout: "ignore", stderr: "ignore", env: { ...Bun.env, HOME: home, ...env } }).exited;
    };
    expect(await main(["apply", "--profile", profile], { home, engineRoot: engine, platform: "linux", env: {}, print, run: runStep })).toBe(0);
    expect(lines.filter((line) => line.startsWith("  … "))).toEqual(["  … tools: box", "  … tools: codex"]);
    expect(namedBeforeItsWork).toEqual({ box: true, codex: true });
    lines.length = 0;
    expect(await main(["apply"], { home, engineRoot: engine, platform: "linux", env: {}, print, run: runStep })).toBe(0);
    expect(lines.filter((line) => line.startsWith("  … "))).toEqual([]);
  });
});
