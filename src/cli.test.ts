import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

async function fleet(args: string[], home: string, engineRoot = repoRoot) {
  const lines: string[] = [];
  const code = await main(args, { home, engineRoot, platform: "linux", print: (line) => lines.push(line), run: async () => 0 });
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
      writeFileSync(join(root, "packs", pack, "pack.json"), JSON.stringify({ schema: 1, name: pack, summary: `${pack} pack.` }));
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
    expect(await fleet(["setup"], home, engine)).toMatchObject({ code: 2, output: "fleet setup is not available in this version yet." });
  });

  test("runs a command from an enabled pack with its arguments", async () => {
    const { home, engine } = await machineWith(["tools"]);
    expect((await fleet(["hello", "a", "b"], home, engine)).code).toBe(0);
    expect(readFileSync(join(home, "hello.txt"), "utf8")).toBe("tools a b");
  });

  test("reports a command that two enabled packs ship", async () => {
    const home = temp.make("home-");
    const result = await fleet(["apply", "--profile", profileDir(["tools", "rival"])], home, engineWithCommands());
    expect(result).toMatchObject({ code: 1, output: "fleet: command hello is shipped by both tools and rival" });
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("names the pack to turn on for a command of a disabled pack", async () => {
    const { home, engine } = await machineWith([]);
    expect(await fleet(["hello"], home, engine)).toMatchObject({ code: 2, output: "fleet hello comes from the rival pack, which is off. Turn it on with fleet packs." });
    expect(existsSync(join(home, "hello.txt"))).toBe(false);
    expect((await fleet(["nope"], home, engine)).output).toStartWith("fleet: unknown command nope");
  });
});

