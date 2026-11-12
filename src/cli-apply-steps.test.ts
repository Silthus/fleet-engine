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
  test("names each step before its work is done, and stays quiet for a step that already holds", async () => {
    const home = temp.make("home-");
    const engine = engineWithTools();
    const profile = profileDir(["tools"]);
    const progress: string[] = [];
    const doneWhenNamed: Record<string, boolean> = {};
    const print = (line: string) => {
      const step = line.match(/^  … tools: (\w+)$/)?.[1];
      if (!step) return;
      progress.push(step);
      doneWhenNamed[step] = existsSync(join(home, `${step}.txt`));
    };
    const apply = (args: string[]) => main(args, { home, engineRoot: engine, platform: "linux", env: {}, print });
    expect(await apply(["apply", "--profile", profile])).toBe(0);
    expect(progress).toEqual(["box", "codex"]);
    expect(doneWhenNamed).toEqual({ box: false, codex: false });
    expect([existsSync(join(home, "box.txt")), existsSync(join(home, "codex.txt"))]).toEqual([true, true]);
    progress.length = 0;
    expect(await apply(["apply"])).toBe(0);
    expect(progress).toEqual([]);
  });
});
