import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli.ts";
import { cliFixtures, repoRoot } from "./testing/cli.ts";
import { tempDirs } from "./testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const { profileDir, engineWithCommands } = cliFixtures(temp);

describe("fleet routing", () => {
  describe("a pack that leaves the profile", () => {
    const box = `const file = Bun.env.HOME + "/box.txt";
const [arg] = Bun.argv.slice(2);
if (arg === "on") await Bun.write(file, "on");
else if (arg === "off") (await import("node:fs")).rmSync(file, { force: true });
else process.exit((await Bun.file(file).exists()) ? 0 : 1);
`;
    function engineWithBox() {
      const engine = engineWithCommands();
      cpSync(join(repoRoot, "src"), join(engine, "src"), { recursive: true });
      cpSync(join(repoRoot, "fleet"), join(engine, "fleet"));
      symlinkSync(join(repoRoot, "node_modules"), join(engine, "node_modules"));
      const base = JSON.parse(readFileSync(join(engine, "packs/base/pack.json"), "utf8"));
      writeFileSync(join(engine, "packs/base/pack.json"), JSON.stringify({ ...base, steps: [] }));
      writeFileSync(join(engine, "packs/tools/pack.json"), JSON.stringify({ schema: 1, name: "tools", summary: "tools pack.", steps: [{ id: "box", run: ["fleet", "box", "on"], check: ["fleet", "box", "status"], undo: ["fleet", "box", "off"] }] }));
      writeFileSync(join(engine, "packs/tools/commands/box.ts"), box);
      return engine;
    }
    const drop = (profile: string) => {
      const file = JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8"));
      writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...file, packs: [] }));
    };
    const run = (args: string[], home: string, engine: string, env: Record<string, string> = {}): Promise<number> =>
      main(args, { home, engineRoot: engine, platform: "linux", env, print: () => {}, run: (command, stepEnv = {}) => (command[1] === join(engine, "fleet") ? run(command.slice(2), home, engine, stepEnv) : spawnStep(command, home, stepEnv)) });
    const spawnStep = (command: string[], home: string, env: Record<string, string>) => Bun.spawn(command, { stdout: "ignore", stderr: "ignore", env: { ...Bun.env, HOME: home, ...env } }).exited;

    test("has its steps undone by the next apply, through the pack's own command", async () => {
      const home = temp.make("home-");
      const engine = engineWithBox();
      const profile = profileDir(["tools"]);
      expect(await run(["apply", "--profile", profile], home, engine)).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(true);
      drop(profile);
      expect(await run(["apply"], home, engine)).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(false);
      writeFileSync(join(home, "box.txt"), "by hand");
      expect(await run(["apply"], home, engine)).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(true);
    });

    test("doctor says what a person removes by hand, through the pack's own probe", async () => {
      const home = temp.make("home-");
      const engine = engineWithBox();
      const manifest = JSON.parse(readFileSync(join(engine, "packs/tools/pack.json"), "utf8"));
      writeFileSync(join(engine, "packs/tools/pack.json"), JSON.stringify({ ...manifest, human: [{ id: "login", say: "Log in to the box.", probe: ["fleet", "box", "status"], undo: "Log out with box logout." }] }));
      const profile = profileDir(["tools"]);
      expect(await run(["apply", "--profile", profile], home, engine)).toBe(0);
      drop(profile);
      const lines: string[] = [];
      await main(["doctor"], { home, engineRoot: engine, platform: "linux", env: {}, print: (line) => lines.push(line) });
      expect(lines.join("\n")).toContain("The tools pack is off. Log out with box logout.");
    });

    test("runs its command only for a command line of the step that the ledger names", async () => {
      const home = temp.make("home-");
      const engine = engineWithBox();
      const profile = profileDir(["tools"]);
      expect(await run(["apply", "--profile", profile], home, engine)).toBe(0);
      drop(profile);
      expect(await run(["box", "off"], home, engine)).toBe(2);
      expect(await run(["box", "off"], home, engine, { FLEET_UNDO: "tools/other" })).toBe(2);
      expect(await run(["box", "off", "--all"], home, engine, { FLEET_UNDO: "tools/box" })).toBe(2);
      expect(existsSync(join(home, "box.txt"))).toBe(true);
      expect(await run(["box", "status"], home, engine, { FLEET_UNDO: "tools/box" })).toBe(0);
      expect(await run(["box", "off"], home, engine, { FLEET_UNDO: "tools/box" })).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(false);
      expect(await run(["box", "on"], home, engine, { FLEET_UNDO: "tools/box" })).toBe(2);
      expect(existsSync(join(home, "box.txt"))).toBe(false);
    });

    test("keeps the step to undo while Fleet cannot run its pack's command, and never runs another pack's command of that name", async () => {
      const home = temp.make("home-");
      const engine = engineWithBox();
      const profile = profileDir(["tools"]);
      expect(await run(["apply", "--profile", profile], home, engine)).toBe(0);
      writeFileSync(join(engine, "packs/rival/commands/box.ts"), `await Bun.write(Bun.env.HOME + "/rival.txt", "ran");\n`);
      const away = join(temp.make("away-"), "tools");
      renameSync(join(engine, "packs/tools"), away);
      writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8")), packs: ["rival"] }));
      expect(await run(["box", "status"], home, engine, { FLEET_UNDO: "tools/box" })).toBe(3);
      await run(["apply"], home, engine);
      expect(existsSync(join(home, "rival.txt"))).toBe(false);
      expect(existsSync(join(home, "box.txt"))).toBe(true);
      renameSync(away, join(engine, "packs/tools"));
      drop(profile);
      expect(await run(["apply"], home, engine)).toBe(0);
      expect(existsSync(join(home, "box.txt"))).toBe(false);
    });
  });
});
