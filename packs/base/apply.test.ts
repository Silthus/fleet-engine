import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cargoGitCliCommand } from "./lib/cargo-git-cli.ts";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { jobsAdapter } from "../../src/adapters/jobs/adapter.ts";
import { main } from "../../src/cli.ts";
import type { Plan } from "../../src/pack/types.ts";
import { apply } from "../../src/reconciler/apply.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { spawnAsync } from "../../src/testing/spawn.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const engineRoot = join(import.meta.dir, "../..");
const launcher = join(engineRoot, "fleet");

function profileWith(settings: Record<string, unknown> = {}, dir = temp.make("profile-")) {
  const profile = { schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [], packs: [], plan: "both", settings, workflows: {} };
  writeFileSync(join(dir, "fleet.json"), JSON.stringify(profile));
  return dir;
}

async function fleet(args: string[], home: string): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const runFleetStepsOnly = async (command: string[]) => (command[1] === launcher ? (await fleet(command.slice(2), home)).code : 0);
  const code = await main(args, { home, engineRoot, platform: "linux", env: {}, print: (line) => lines.push(line), run: runFleetStepsOnly });
  return { code, output: lines.join("\n") };
}

const emptyPlan: Plan = {
  machine: { schema: 1, role: "linux" },
  os: "linux",
  ai: "both",
  packs: [{ name: "base", source: "engine", ref: "main", available: true }],
  workflows: [],
  files: [],
  config: [],
  owners: {},
  jobs: [],
  human: [],
  steps: [],
  checks: [],
  commands: {},
  handlers: {},
  settings: {},
  unanswered: [],
  ask: [],
  dropped: [],
  models: [],
};

type HookGroup ={ hooks: Array<{ command: string }> };

function installedHook(home: string, provider: "claude" | "codex", event: string) {
  const config = provider === "claude" ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : parseToml(readFileSync(join(home, ".codex/config.toml"), "utf8"));
  const groups = (config.hooks as Record<string, HookGroup[] | undefined>)[event];
  if (!groups?.[0]?.hooks[0]) throw new Error(`${provider} has no ${event} hook`);
  return groups[0].hooks[0].command;
}

function addFixtureHook(home: string, event: string) {
  const dir = join(home, ".config/fleet/hooks", event);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture.ts"), 'process.stdout.write(`${Bun.argv[2]} saw ${await Bun.stdin.text()}`);\n');
}

async function fire(home: string, command: string, input: unknown) {
  const child = Bun.spawn(["sh", "-c", command], { env: { ...Bun.env, HOME: home }, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
}

describe("the Base pack's hook events", () => {
  test.each([
    ["claude", "SessionStart", { hook_event_name: "SessionStart", source: "startup" }],
    ["codex", "SessionStart", { hook_event_name: "SessionStart", source: "startup" }],
    ["codex", "PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }],
  ] as const)("a %s %s input reaches a pack's hook through the dispatcher", async (provider, event, input) => {
    const home = temp.make("home-");
    expect((await fleet(["apply", "--profile", profileWith()], home)).code).toBe(0);
    addFixtureHook(home, event);
    expect(await fire(home, installedHook(home, provider, event), input)).toEqual({ code: 0, stdout: `${provider} saw ${JSON.stringify(input)}` });
  });
});

describe("the Linux session", () => {
  const userBus = `unix:path=/run/user/${process.getuid!()}/bus`;
  const cronEnvironment = (home: string) => ({ HOME: home, PATH: "/usr/bin:/bin" });
  const ubuntuBashrc = 'case $- in\n    *i*) ;;\n      *) return;;\nesac\nalias ll="ls -l"\n';
  const read = (home: string, file: string) => readFileSync(join(home, file), "utf8");

  async function shell(home: string, command: string[], env: Record<string, string> = {}) {
    const child = Bun.spawn(command, { env: { ...cronEnvironment(home), ...env }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return stdout.trim();
  }

  test("an interactive shell, a login shell, and an ssh command all see the user bus and Fleet's PATH, and the person's own lines stay", async () => {
    const home = temp.make("home-");
    writeFileSync(join(home, ".bashrc"), ubuntuBashrc);
    writeFileSync(join(home, ".bash_profile"), '[ -f ~/.bashrc ] && . ~/.bashrc\nexport EDITOR=vi\n');
    expect((await fleet(["apply", "--profile", profileWith()], home)).code).toBe(0);
    const seen = 'printf "%s|%s" "$DBUS_SESSION_BUS_ADDRESS" "$PATH"';
    const wanted = `${userBus}|${home}/.local/bin:${home}/.bun/bin:`;
    expect(await shell(home, ["bash", "-ic", seen])).toStartWith(wanted);
    expect(await shell(home, ["bash", "-lc", seen])).toStartWith(wanted);
    expect(await shell(home, ["bash", "-c", seen], { SSH_CLIENT: "192.0.2.1 50000 22", SHLVL: "0" })).toStartWith(wanted);
    expect(read(home, ".bashrc")).toEndWith(ubuntuBashrc);
    expect(read(home, ".bash_profile")).toEndWith("export EDITOR=vi\n");
  });

  test("a second apply adds no second line, and a home without bash files gets .bashrc and .profile", async () => {
    const home = temp.make("home-");
    const profile = profileWith();
    await fleet(["apply", "--profile", profile], home);
    const first = { bashrc: read(home, ".bashrc"), profile: read(home, ".profile") };
    await fleet(["apply"], home);
    expect({ bashrc: read(home, ".bashrc"), profile: read(home, ".profile") }).toEqual(first);
    expect(first.bashrc.trim().split("\n")).toHaveLength(1);
    expect(await shell(home, ["bash", "-lc", 'printf %s "$DBUS_SESSION_BUS_ADDRESS"'])).toBe(userBus);
  });

  test("a source line inside a block below an early return gets a first line too, so an ssh command still sees the user bus", async () => {
    const home = temp.make("home-");
    const ownSourceLine = '[ -r "$HOME/.config/fleet/session.sh" ] && . "$HOME/.config/fleet/session.sh"';
    const bashrc = `${ubuntuBashrc}if true; then\n${ownSourceLine}\nfi\n`;
    writeFileSync(join(home, ".bashrc"), bashrc);
    expect((await fleet(["apply", "--profile", profileWith()], home)).code).toBe(0);
    expect(await shell(home, ["bash", "-c", 'printf %s "$DBUS_SESSION_BUS_ADDRESS"'], { SSH_CLIENT: "192.0.2.1 50000 22", SHLVL: "0" })).toBe(userBus);
    expect(read(home, ".bashrc")).toEndWith(bashrc);
    expect((await spawnAsync(["bash", "-n", join(home, ".bashrc")])).exitCode).toBe(0);
  });

  test("a startup file that Fleet cannot read is left as it is", async () => {
    const home = temp.make("home-");
    writeFileSync(join(home, ".bashrc"), ubuntuBashrc, { mode: 0o200 });
    expect((await fleet(["apply", "--profile", profileWith()], home)).code).toBe(1);
    await spawnAsync(["chmod", "600", join(home, ".bashrc")]);
    expect(read(home, ".bashrc")).toBe(ubuntuBashrc);
  });

  test("a bus address and runtime folder that are already set stay, and sourcing twice adds Fleet's folders to PATH once", async () => {
    const home = temp.make("home-");
    await fleet(["apply", "--profile", profileWith()], home);
    const twice = '. "$HOME/.config/fleet/session.sh"; . "$HOME/.config/fleet/session.sh"; printf "%s|%s|%s" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" "$PATH"';
    const set = { XDG_RUNTIME_DIR: "/run/custom", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/custom/other-bus" };
    expect(await shell(home, ["/bin/sh", "-c", twice], set)).toBe(`/run/custom|unix:path=/run/custom/other-bus|${home}/.local/bin:${home}/.bun/bin:/usr/bin:/bin`);
  });

  test("a session turns off agent-browser's Chrome version check, which fetches a web page on each start, and keeps a value the person set", async () => {
    const home = temp.make("home-");
    await fleet(["apply", "--profile", profileWith()], home);
    const seen = 'printf %s "$AGENT_BROWSER_NO_VERSION_CHECK"';
    expect(await shell(home, ["bash", "-lc", seen])).toBe("1");
    expect(await shell(home, ["bash", "-lc", seen], { AGENT_BROWSER_NO_VERSION_CHECK: "0" })).toBe("0");
  });

  test("a cron job started with only HOME and PATH sees the user bus", async () => {
    const home = temp.make("home-");
    await fleet(["apply", "--profile", profileWith()], home);
    const crontab = { text: "" };
    const runCrontab = async (command: string[], options?: { input?: string }) => (command[1] === "-" ? ((crontab.text = options?.input ?? ""), { code: 0, stdout: "" }) : { code: 0, stdout: crontab.text });
    const job = { id: "bus-check", pack: "base", command: ["sh", "-c", 'printf %s "$DBUS_SESSION_BUS_ADDRESS"'], schedule: { every: "5m" as const } };
    await apply({ ...emptyPlan, os: "linux", jobs: [job] }, { home, adapters: [jobsAdapter({ run: runCrontab, engineRoot })] });
    const cronCommand = crontab.text.split("\n").find((line) => line.includes("bus-check"))!.split(" ").slice(5).join(" ");
    await shell(home, ["/bin/sh", "-c", cronCommand]);
    expect(read(home, ".local/state/fleet/jobs/bus-check.log")).toBe(userBus);
  });
});

describe("Cargo on Linux", () => {
  const cargoConfig = (home: string) => join(home, ".cargo/config.toml");

  test("fetches Git dependencies with the Git CLI, so they use Fleet's SSH command instead of only the SSH agent", async () => {
    const home = temp.make("home-");
    expect((await fleet(["apply", "--profile", profileWith()], home)).code).toBe(0);
    expect(parseToml(readFileSync(cargoConfig(home), "utf8"))).toEqual({ net: { "git-fetch-with-cli": true } });
  });

  test.each([".cargo/config.toml", ".cargo/config"])("keeps the person's own %s as it is, and apply still passes", async (file) => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".cargo"));
    writeFileSync(join(home, file), "[build]\njobs = 4\n");
    expect((await fleet(["apply", "--profile", profileWith()], home)).code).toBe(0);
    expect(readFileSync(join(home, file), "utf8")).toBe("[build]\njobs = 4\n");
    expect(readdirSync(join(home, ".cargo"))).toEqual([file.slice(".cargo/".length)]);
  });

  test.skipIf(process.getuid?.() === 0).each(["a read-only folder", "a file"])("leaves a Cargo home that is %s alone, and the later Base steps still run", async (kind) => {
    const home = temp.make("home-");
    if (kind === "a file") writeFileSync(join(home, ".cargo"), "");
    else mkdirSync(join(home, ".cargo"), { mode: 0o500 });
    expect((await fleet(["apply", "--profile", profileWith()], home)).code).toBe(0);
    if (kind !== "a file") expect(readdirSync(join(home, ".cargo"))).toEqual([]);
    chmodSync(join(home, ".cargo"), 0o700);
  });

  test("writes the config into CARGO_HOME when it is set, which is where Cargo reads it", async () => {
    const home = temp.make("home-");
    const cargoHome = join(temp.make("cargo-"), "home");
    expect(await cargoGitCliCommand([], { home, cargoHome })).toBe(0);
    expect(parseToml(readFileSync(join(cargoHome, "config.toml"), "utf8"))).toEqual({ net: { "git-fetch-with-cli": true } });
    expect(await cargoGitCliCommand(["--check"], { home, cargoHome })).toBe(0);
    expect(await cargoGitCliCommand(["--check"], { home })).toBe(1);
  });
});

describe("the settings snapshot", () => {
  const snapshotFile = (home: string) => join(home, ".local/state/fleet/settings.json");
  const snapshot = (home: string) => JSON.parse(readFileSync(snapshotFile(home), "utf8"));

  test("holds the resolved settings, readable only by the person, and follows a changed setting", async () => {
    const home = temp.make("home-");
    const profile = profileWith();
    expect((await fleet(["apply", "--profile", profile], home)).code).toBe(0);
    expect(snapshot(home)).toMatchObject({ "base.heavySlots": 2, "base.diskFloorGigabytes": 10 });
    expect(statSync(snapshotFile(home)).mode & 0o777).toBe(0o600);

    profileWith({ "base.heavySlots": 3 }, profile);
    expect((await fleet(["doctor"], home)).output).toContain("Step settings-snapshot of the base pack does not pass its check.");
    expect((await fleet(["apply"], home)).code).toBe(0);
    expect(snapshot(home)).toMatchObject({ "base.heavySlots": 3 });
    expect((await fleet(["doctor"], home)).output).not.toContain("settings-snapshot");
  });

  test("a snapshot that someone else can read is written again", async () => {
    const home = temp.make("home-");
    const profile = profileWith();
    await fleet(["apply", "--profile", profile], home);
    await spawnAsync(["chmod", "644", snapshotFile(home)]);
    expect((await fleet(["doctor"], home)).output).toContain("Step settings-snapshot of the base pack does not pass its check.");
    await fleet(["apply"], home);
    expect(statSync(snapshotFile(home)).mode & 0o777).toBe(0o600);
  });
});
