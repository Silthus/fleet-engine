import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { main } from "./cli.ts";
import { tempDirs } from "./testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "..");

function profileDir(packs: string[] = [], aboutMe?: string) {
  const dir = temp.make("profile-");
  const profile = { schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [], packs, plan: "both", settings: {}, workflows: {} };
  writeFileSync(join(dir, "fleet.json"), JSON.stringify(profile));
  if (aboutMe) writeFileSync(join(dir, "about-me.md"), aboutMe);
  return dir;
}

async function fleet(args: string[], home: string, engineRoot = repoRoot, env: Record<string, string> = {}) {
  const lines: string[] = [];
  const code = await main(args, { home, engineRoot, platform: "linux", env, print: (line) => lines.push(line), run: async () => 0 });
  return { code, output: lines.join("\n") };
}

function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      const key = relative(root, path);
      if (info.isDirectory()) {
        entries[key] = `dir ${info.mtimeMs}`;
        walk(path);
      } else entries[key] = info.isSymbolicLink() ? `link ${info.mtimeMs}` : `${info.mtimeMs} ${readFileSync(path, "utf8")}`;
    }
  };
  walk(root);
  return entries;
}

describe("fleet apply", () => {
  test("puts the base pack's rules on a fresh machine and remembers the profile", async () => {
    const home = temp.make("home-");
    const profile = profileDir();
    const result = await fleet(["apply", "--profile", profile], home);
    expect(result).toMatchObject({ code: 0 });
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toStartWith("# Agent rules\n");
    expect(readFileSync(join(home, ".codex/AGENTS.md"), "utf8")).toBe(readFileSync(join(home, ".agents/AGENTS.md"), "utf8"));
    expect(JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8"))).toEqual({ schema: 1, role: "linux", profileDir: profile });
    expect((await fleet(["apply"], home)).output).toContain("Applied 0 changes.");
  });

  test("a profile the parent passes down is checked by doctor, but never applied or remembered", async () => {
    const home = temp.make("home-");
    const remembered = profileDir([], "# Remembered\n");
    const passedDown = { FLEET_PROFILE_DIR: profileDir([], "# Passed down\n") };
    expect((await fleet(["apply", "--profile", remembered], home)).code).toBe(0);

    const doctor = await fleet(["doctor"], home, repoRoot, passedDown);
    expect(doctor).toMatchObject({ code: 1 });
    expect(doctor.output).toContain(".agents/AGENTS.md needs to be updated.");

    expect((await fleet(["apply"], home, repoRoot, passedDown)).code).toBe(0);
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toContain("# Remembered");
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).not.toContain("# Passed down");
    expect(JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8")).profileDir).toBe(remembered);
  });

  describe("in a Coder workspace", () => {
    const machineFile = (home: string) => JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8"));
    const signer = (home: string) => readFileSync(join(home, ".agents/guides/skill-settings.md"), "utf8").match(/`identity\.signer`: `(\w+)`/)?.[1];
    const slice = ".config/systemd/user/fleet-heavy.slice";

    test("a fresh box gets role devbox, the coder signer, and the devbox workflows", async () => {
      const home = temp.make("home-");
      const profile = profileDir();
      expect(await fleet(["apply", "--profile", profile], home, repoRoot, { CODER: "true", CODER_AGENT_URL: "https://coder.example.test/" })).toMatchObject({ code: 0 });
      expect(machineFile(home)).toEqual({ schema: 1, role: "devbox", coder: true, profileDir: profile });
      expect(signer(home)).toBe("coder");
      expect(existsSync(join(home, slice))).toBe(true);
    });

    test("the box stays a Coder devbox when a later run lacks the Coder variables, as cron does", async () => {
      const home = temp.make("home-");
      const profile = profileDir();
      await fleet(["apply", "--profile", profile], home, repoRoot, { CODER_AGENT_URL: "https://coder.example.test/" });
      expect(await fleet(["apply"], home)).toMatchObject({ code: 0 });
      expect(machineFile(home)).toMatchObject({ role: "devbox", coder: true });
      expect(signer(home)).toBe("coder");
    });

    test("a box saved as linux before becomes a devbox", async () => {
      const home = temp.make("home-");
      const profile = profileDir();
      await fleet(["apply", "--profile", profile], home);
      expect(machineFile(home).role).toBe("linux");
      await fleet(["apply"], home, repoRoot, { CODER: "true" });
      expect(machineFile(home)).toMatchObject({ role: "devbox", coder: true });
      expect(signer(home)).toBe("coder");
    });

    test("without the Coder variables, a Linux machine gets role linux and the ssh signer", async () => {
      const home = temp.make("home-");
      await fleet(["apply", "--profile", profileDir()], home, repoRoot, { CODER: "false" });
      expect(machineFile(home).role).toBe("linux");
      expect(machineFile(home).coder).toBeUndefined();
      expect(signer(home)).toBe("ssh");
      expect(existsSync(join(home, slice))).toBe(false);
    });
  });

  test("removes a stale proxy URL from Claude Code's settings, and doctor sees it first", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: "proxy-key" }, model: "opus" }));
    const profile = profileDir();
    await fleet(["apply", "--profile", profile, "--dry-run"], home);
    const doctor = await fleet(["doctor", "--profile", profile], home);
    expect(doctor.output).toMatch(/Fix: \.claude\/settings\.json needs an update: .*remove env\.ANTHROPIC_BASE_URL, env\.ANTHROPIC_AUTH_TOKEN\./);
    const result = await fleet(["apply", "--profile", profile], home);
    expect(result.output).toContain("replace .claude/settings.json");
    const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
    expect(settings.env).toBeUndefined();
    expect(settings.model).toBe("opus");
  });

  test("keeps an unmanaged file and a local edit, and says so", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/AGENTS.md"), "my own codex rules\n");
    const profile = profileDir();
    const first = await fleet(["apply", "--profile", profile], home);
    expect(first.code).toBe(0);
    expect(first.output).toContain("Kept your .codex/AGENTS.md (Existing unmanaged item).");
    expect(readFileSync(join(home, ".codex/AGENTS.md"), "utf8")).toBe("my own codex rules\n");

    writeFileSync(join(home, ".agents/AGENTS.md"), "my edit\n");
    writeFileSync(join(profile, "about-me.md"), "I like small diffs.\n");
    const second = await fleet(["apply"], home);
    expect(second.code).toBe(0);
    expect(second.output).toContain("Kept your .agents/AGENTS.md (Managed file changed locally).");
    expect(readFileSync(join(home, ".agents/AGENTS.md"), "utf8")).toBe("my edit\n");
    expect(readFileSync(join(home, ".claude/rules/fleet.md"), "utf8")).toContain("I like small diffs.");
  });

  test("--adopt takes Fleet's version and backs up the user's file", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/AGENTS.md"), "my own codex rules\n");
    const result = await fleet(["apply", "--profile", profileDir(), "--adopt", ".codex/AGENTS.md"], home);
    expect(result.code).toBe(0);
    expect(readFileSync(join(home, ".codex/AGENTS.md"), "utf8")).toStartWith("# Agent rules\n");
    const backups = join(home, ".local/state/fleet/backups");
    const [run] = readdirSync(backups);
    expect(readFileSync(join(backups, run ?? "", ".codex/AGENTS.md"), "utf8")).toBe("my own codex rules\n");
  });

  test("--dry-run previews without writing machine state", async () => {
    const home = temp.make("home-");
    const result = await fleet(["apply", "--dry-run", "--profile", profileDir()], home);
    expect(result.output).toContain("Preview: 11 changes to apply. Nothing was written.");
    expect(readdirSync(home)).toEqual([]);
  });

  test("refuses without a profile", async () => {
    expect(await fleet(["apply"], temp.make("home-"))).toMatchObject({ code: 1, output: expect.stringContaining("no profile on this machine") });
  });
});

describe("fleet doctor", () => {
  test("never writes, on a fresh machine and on a drifted one", async () => {
    const home = temp.make("home-");
    const profile = profileDir();
    const fresh = snapshot(home);
    const before = await fleet(["doctor", "--profile", profile], home);
    expect(before.code).toBe(1);
    expect(before.output).toContain("Fix: .agents/AGENTS.md needs to be created.");
    expect(snapshot(home)).toEqual(fresh);

    await fleet(["apply", "--profile", profile], home);
    expect(await fleet(["doctor"], home)).toMatchObject({ code: 0, output: "Everything matches your profile." });
    writeFileSync(join(home, ".agents/AGENTS.md"), "my edit\n");
    writeFileSync(join(profile, "about-me.md"), "New about me.\n");
    const drifted = snapshot(home);
    const after = await fleet(["doctor"], home);
    expect(after.output).toContain("Kept your .agents/AGENTS.md");
    expect(after.output).toContain("Fix: .codex/AGENTS.md needs to be updated.");
    expect(snapshot(home)).toEqual(drifted);
  });
});

describe("fleet routing", () => {
  function engineWithCommands() {
    const root = temp.make("engine-");
    cpSync(join(repoRoot, "packs/base"), join(root, "packs/base"), { recursive: true });
    for (const pack of ["tools", "rival"]) {
      mkdirSync(join(root, "packs", pack, "commands"), { recursive: true });
      writeFileSync(join(root, "packs", pack, "pack.json"), JSON.stringify({ schema: 1, name: pack, summary: `${pack} pack.`, ...(pack === "rival" ? { title: "Rival Tools" } : {}) }));
      writeFileSync(join(root, "packs", pack, "commands/hello.ts"), `await Bun.write(Bun.env.HOME + "/hello.txt", "${pack} " + Bun.argv.slice(2).join(" "));\n`);
    }
    return root;
  }

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

