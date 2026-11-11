import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli.ts";
import { cliFixtures, repoRoot } from "./testing/cli.ts";
import { tempDirs } from "./testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const { profileDir, fleet, engineWithCommands } = cliFixtures(temp);

describe("fleet routing", () => {
  async function machineWith(packs: string[]) {
    const home = temp.make("home-");
    const engine = engineWithCommands();
    expect((await fleet(["apply", "--profile", profileDir(packs)], home, engine)).code).toBe(0);
    return { home, engine };
  }

  test("runs an engine command", async () => {
    const { home, engine } = await machineWith(["tools"]);
    expect(await fleet(["doctor"], home, engine)).toMatchObject({ code: 0 });
  });

  test("runs a command from an enabled pack with its arguments", async () => {
    const { home, engine } = await machineWith(["tools"]);
    expect((await fleet(["hello", "a", "b"], home, engine)).code).toBe(0);
    expect(readFileSync(join(home, "hello.txt"), "utf8")).toBe("tools a b");
  });

  test("gives a pack command the resolved settings, defaults and profile answers included", async () => {
    const home = temp.make("home-");
    const engine = engineWithCommands();
    const tools = join(engine, "packs/tools");
    const settings = [
      { key: "tools.slots", question: "How many?", type: "number", default: 2 },
      { key: "tools.name", question: "Which name?", type: "string", default: "plain" },
    ];
    writeFileSync(join(tools, "pack.json"), JSON.stringify({ schema: 1, name: "tools", summary: "tools pack.", settings }));
    writeFileSync(join(tools, "commands/hello.ts"), `await Bun.write(Bun.env.HOME + "/hello.txt", Bun.env.FLEET_SETTINGS ?? "none");\n`);
    const profile = profileDir(["tools"]);
    const file = JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8"));
    writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...file, settings: { "tools.name": "mine" } }));
    expect((await fleet(["apply", "--profile", profile], home, engine)).code).toBe(0);
    expect((await fleet(["hello"], home, engine)).code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "hello.txt"), "utf8"))).toMatchObject({ "tools.slots": 2, "tools.name": "mine" });
  });

  test("gives a pack command the handlers that enabled packs declare", async () => {
    const home = temp.make("home-");
    const engine = engineWithCommands();
    writeFileSync(join(engine, "packs/rival/pack.json"), JSON.stringify({ schema: 1, name: "rival", summary: "rival pack.", handlers: [{ seam: "review-bot", path: "lib/bot.ts" }] }));
    writeFileSync(join(engine, "packs/tools/commands/hello.ts"), `await Bun.write(Bun.env.HOME + "/hello.txt", Bun.env.FLEET_HANDLERS ?? "none");\n`);
    rmSync(join(engine, "packs/rival/commands/hello.ts"));
    mkdirSync(join(engine, "packs/rival/lib"));
    writeFileSync(join(engine, "packs/rival/lib/bot.ts"), "export {};\n");
    expect((await fleet(["apply", "--profile", profileDir(["tools", "rival"])], home, engine)).code).toBe(0);
    expect((await fleet(["hello"], home, engine)).code).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "hello.txt"), "utf8"))).toEqual({ "review-bot": join(engine, "packs/rival/lib/bot.ts") });
  });

  test("gives a pack command the model table of the user's AI plan", async () => {
    const { home, engine } = await machineWith(["tools"]);
    writeFileSync(join(engine, "packs/tools/commands/hello.ts"), `await Bun.write(Bun.env.HOME + "/hello.txt", Bun.env.FLEET_MODELS ?? "none");\n`);
    expect((await fleet(["hello"], home, engine)).code).toBe(0);
    const models = JSON.parse(readFileSync(join(home, "hello.txt"), "utf8"));
    expect(models.map((row: { role: string }) => row.role)).toEqual(["lookup", "survey", "research", "implementation", "review", "review-codex"]);
    expect(models.find((row: { role: string }) => row.role === "review")).toMatchObject({ provider: "codex" });
  });

  test("gives a pack command the user's AI plan", async () => {
    const { home, engine } = await machineWith(["tools"]);
    writeFileSync(join(engine, "packs/tools/commands/hello.ts"), `await Bun.write(Bun.env.HOME + "/hello.txt", Bun.env.FLEET_PLAN ?? "none");\n`);
    expect((await fleet(["hello"], home, engine)).code).toBe(0);
    expect(readFileSync(join(home, "hello.txt"), "utf8")).toBe("both");
  });

  test.if(process.platform === "linux")("runs a fleet heavy job as the fleet process itself, so a stop sent only to fleet reaches the job once", async () => {
    const home = temp.make("home-");
    const engine = engineWithCommands();
    cpSync(join(repoRoot, "src"), join(engine, "src"), { recursive: true });
    cpSync(join(repoRoot, "fleet"), join(engine, "fleet"));
    symlinkSync(join(repoRoot, "node_modules"), join(engine, "node_modules"));
    const profile = profileDir(["tools"]);
    const saved = JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8"));
    writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...saved, settings: { "base.heavySlots": 1, "base.diskFloorGigabytes": 0 } }));
    expect((await fleet(["apply", "--profile", profile], home, engine)).code).toBe(0);
    const bin = temp.make("bin-");
    writeFileSync(join(bin, "systemd-run"), `#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n`, { mode: 0o755 });
    const env = { ...Bun.env, HOME: home, XDG_RUNTIME_DIR: home, PATH: `${bin}:${Bun.env.PATH}` };
    const stops = join(home, "stops");
    const job = Bun.spawn(["sh", join(engine, "fleet"), "heavy", "--", "sh", "-c", `tail -f /dev/null 9>&- & tail=$!; trap 'kill $tail; echo TERM >> "$0"; exit 143' TERM; echo $$; wait $tail`, stops], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    try {
      const reader = job.stdout.getReader();
      let said = "";
      while (!said.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        said += new TextDecoder().decode(value);
      }
      expect(said).toBe(`${job.pid}\n`);
      process.kill(job.pid, "SIGTERM");
      expect(await job.exited).toBe(143);
      expect(readFileSync(stops, "utf8")).toBe("TERM\n");
    } finally {
      try { process.kill(-job.pid, "SIGKILL"); } catch {}
    }
  });

  test("runs a leading fleet in a pack step with this engine's launcher, not one on PATH", async () => {
    const home = temp.make("home-");
    const engine = engineWithCommands();
    cpSync(join(repoRoot, "src"), join(engine, "src"), { recursive: true });
    cpSync(join(repoRoot, "fleet"), join(engine, "fleet"));
    symlinkSync(join(repoRoot, "node_modules"), join(engine, "node_modules"));
    const base = JSON.parse(readFileSync(join(engine, "packs/base/pack.json"), "utf8"));
    writeFileSync(join(engine, "packs/base/pack.json"), JSON.stringify({ ...base, steps: [] }));
    writeFileSync(join(engine, "packs/tools/pack.json"), JSON.stringify({ schema: 1, name: "tools", summary: "tools pack.", steps: [{ id: "greet", run: ["fleet", "hello", "from-step"] }] }));
    const lines: string[] = [];
    const code = await main(["apply", "--profile", profileDir(["tools"])], { home, engineRoot: engine, platform: "linux", env: {}, print: (line) => lines.push(line) });
    expect({ code, output: lines.join("\n") }).toMatchObject({ code: 0 });
    expect(readFileSync(join(home, "hello.txt"), "utf8")).toBe("tools from-step");
  });

  test("doctor --profile runs the nested fleet in a step's check against that profile, not the remembered one", async () => {
    const home = temp.make("home-");
    const engine = engineWithCommands();
    cpSync(join(repoRoot, "src"), join(engine, "src"), { recursive: true });
    cpSync(join(repoRoot, "fleet"), join(engine, "fleet"));
    symlinkSync(join(repoRoot, "node_modules"), join(engine, "node_modules"));
    const base = JSON.parse(readFileSync(join(engine, "packs/base/pack.json"), "utf8"));
    writeFileSync(join(engine, "packs/base/pack.json"), JSON.stringify({ ...base, steps: [] }));
    const settings = [{ key: "tools.name", question: "Which name?", type: "string" }];
    writeFileSync(join(engine, "packs/tools/pack.json"), JSON.stringify({ schema: 1, name: "tools", summary: "tools pack.", settings, steps: [{ id: "greet", run: ["true"], check: ["fleet", "hello"] }] }));
    writeFileSync(join(engine, "packs/tools/commands/hello.ts"), `await Bun.write(Bun.env.HOME + "/hello.txt", JSON.parse(Bun.env.FLEET_SETTINGS ?? "{}")["tools.name"] ?? "none");\n`);
    const named = (name: string) => {
      const dir = profileDir(["tools"]);
      const file = JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8"));
      writeFileSync(join(dir, "fleet.json"), JSON.stringify({ ...file, settings: { "tools.name": name } }));
      return dir;
    };
    const remembered = named("remembered");
    const chosen = named("chosen");
    const run = (args: string[]) => main(args, { home, engineRoot: engine, platform: "linux", env: {}, print: () => {} });
    expect(await run(["apply", "--profile", remembered])).toBe(0);
    expect(readFileSync(join(home, "hello.txt"), "utf8")).toBe("remembered");

    await run(["doctor", "--profile", chosen]);
    expect(readFileSync(join(home, "hello.txt"), "utf8")).toBe("chosen");
    expect(JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8")).profileDir).toBe(remembered);
  });

  test("doctor --profile runs a pack.ts check against that profile, not the remembered one", async () => {
    const home = temp.make("home-");
    const engine = engineWithCommands();
    cpSync(join(repoRoot, "src"), join(engine, "src"), { recursive: true });
    cpSync(join(repoRoot, "fleet"), join(engine, "fleet"));
    symlinkSync(join(repoRoot, "node_modules"), join(engine, "node_modules"));
    const base = JSON.parse(readFileSync(join(engine, "packs/base/pack.json"), "utf8"));
    writeFileSync(join(engine, "packs/base/pack.json"), JSON.stringify({ ...base, steps: [] }));
    mkdirSync(join(engine, "packs/probe"));
    writeFileSync(
      join(engine, "packs/probe/pack.ts"),
      `export default { sdk: 1, name: "probe", summary: "probe pack.", register(fleet) {
  const greeting = fleet.setting({ key: "probe.greeting", type: "string", question: "Which greeting?" });
  fleet.check({ id: "probe-greeted", say: "Greet with the chosen profile.", test: async (ctx) => ctx.get(greeting) === "chosen" });
} };\n`,
    );
    const named = (name: string) => {
      const dir = profileDir(["probe"]);
      const file = JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8"));
      writeFileSync(join(dir, "fleet.json"), JSON.stringify({ ...file, settings: { "probe.greeting": name } }));
      return dir;
    };
    const lines: string[] = [];
    const run = (args: string[]) => main(args, { home, engineRoot: engine, platform: "linux", env: {}, print: (line) => lines.push(line) });
    await run(["apply", "--profile", named("remembered")]);
    lines.length = 0;
    await run(["doctor"]);
    expect(lines).toContain("To do: Greet with the chosen profile.");

    lines.length = 0;
    await run(["doctor", "--profile", named("chosen")]);
    expect(lines).not.toContain("To do: Greet with the chosen profile.");
  });

  test("reports a command that two enabled packs ship", async () => {
    const home = temp.make("home-");
    const result = await fleet(["apply", "--profile", profileDir(["tools", "rival"])], home, engineWithCommands());
    expect(result).toMatchObject({ code: 1, output: "fleet: command hello is shipped by both tools and rival" });
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("names the pack to turn on for a command of a disabled pack", async () => {
    const { home, engine } = await machineWith([]);
    expect(await fleet(["hello"], home, engine)).toMatchObject({ code: 2, output: "fleet hello comes from the Rival Tools pack, which is off. Turn it on with fleet packs." });
    expect(existsSync(join(home, "hello.txt"))).toBe(false);
    expect((await fleet(["nope"], home, engine)).output).toStartWith("fleet: unknown command nope");
  });
});
