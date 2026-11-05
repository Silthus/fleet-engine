import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./testing/git.ts";
import { getShHarness, onLinuxHost, repoRoot } from "./testing/get-sh.ts";

const { temp, engine, sandbox, profile, getSh } = getShHarness();

describe("get.sh", () => {
  test("passes sh -n", () => {
    expect(Bun.spawnSync(["sh", "-n", join(repoRoot, "get.sh")]).exitCode).toBe(0);
    expect(Bun.spawnSync(["sh", "-n", join(repoRoot, "templates/profile/install.sh")]).exitCode).toBe(0);
  });

  test("on Linux installs gh and T3 Code, fetches the engine at its pin, and applies the profile", () => {
    const box = sandbox("Linux");
    const result = getSh(box, ["--ref", "v0.1.0", "--profile", profile()]);
    expect(result.output).toContain("Applied 13 changes.");
    expect(result.code).toBe(0);
    expect(existsSync(join(box.home, ".local/bin/gh"))).toBe(true);
    expect(result.calls).toContain("t3 installer channel=nightly");
    expect(result.calls).not.toContain("brew");
    expect(git(join(box.home, ".local/share/fleet/engine"), "describe", "--tags")).toBe("v0.1.0");
    expect(readFileSync(join(box.home, ".agents/AGENTS.md"), "utf8")).toStartWith("# Agent rules\n");
  });

  test("--install-only installs the tools and the engine, then stops before setup", () => {
    const box = sandbox("Linux");
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(result.output).toEndWith("Fleet: Engine ready at v0.1.0 in " + join(box.home, ".local/share/fleet/engine") + ".\n");
    expect(existsSync(join(box.home, ".local/bin/gh"))).toBe(true);
    expect(existsSync(join(box.home, ".config/fleet/machine.json"))).toBe(false);
  });

  onLinuxHost("on macOS installs Homebrew, gh, and the T3 Code app, then applies the profile", () => {
    const box = sandbox("Darwin");
    const result = getSh(box, ["--ref", "v0.1.0", "--profile", profile()]);
    expect(result.code).toBe(0);
    const calls = result.calls.split("\n");
    expect(calls.indexOf("brew install gh")).toBeGreaterThan(-1);
    expect(calls).toContain("brew install --cask t3-code");
    expect(calls).not.toContain("brew install bun");
    expect(result.calls).toContain("t3 installer channel=nightly");
    expect(result.output).toContain("Applied 13 changes.");
  });

  onLinuxHost("under curl | sh, gives the Homebrew installer the terminal so it can ask for the password", () => {
    const box = sandbox("Darwin");
    const command = `printf 'piped script\\n' | sh ${join(repoRoot, "get.sh")} --ref v0.1.0 --profile ${profile()}`;
    const env = { PATH: box.bin, HOME: box.home, SHELL: "/bin/sh", FLEET_ENGINE_REPO: engine.repo, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const result = Bun.spawnSync([Bun.which("script") ?? "script", "-qec", command, "/dev/null"], { env, stdin: "ignore" });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(box.log, "utf8")).toContain("brew installer stdin=tty");
  });

  onLinuxHost("on macOS installs the Command Line Tools first and waits until they are there", () => {
    const box = sandbox("Darwin");
    const count = join(box.root, "xcode-checks");
    box.stub("xcode-select", `[ "$1" = -p ] || exit 0\nn=$(cat "${count}" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${count}"; [ $n -ge 3 ]`);
    box.stub("sleep", "exit 0");
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Installing the Command Line Tools. Finish the window that opens; this script waits.");
    const calls = result.calls.split("\n");
    expect(calls.slice(0, 5)).toEqual(["uname -s", "xcode-select -p", "xcode-select --install", "xcode-select -p", "sleep 5"]);
    const passed = calls.indexOf("xcode-select -p", 4);
    expect(passed).toBeGreaterThanOrEqual(0);
    expect(passed).toBeLessThan(calls.findIndex((call) => call.startsWith("curl ")));
  });

  onLinuxHost("on macOS with Homebrew present, skips its installer and installs Bun with brew when Bun is missing", () => {
    const box = sandbox("Darwin", { without: ["bun"] });
    box.stub("brew", `[ "$2" = bun ] && cp "${join(box.root, "fake-bun")}" "${join(box.bin, "bun")}"; exit 0`);
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("Installing Homebrew");
    expect(result.calls).not.toContain("Homebrew/install");
    const calls = result.calls.split("\n");
    expect(calls).toContain("brew install gh");
    expect(calls).toContain("brew install bun");
    expect(calls).toContain("brew install --cask t3-code");
  });

  onLinuxHost("on macOS stops when the Homebrew installer leaves no brew on PATH", () => {
    const box = sandbox("Darwin", { brewInstaller: "exit 0" });
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Fleet: Homebrew installed, but brew is not on PATH.");
    expect(result.calls).not.toContain("brew install");
    expect(existsSync(join(box.home, ".local/share/fleet/engine"))).toBe(false);
  });

  onLinuxHost("under curl | sh, hands fleet setup the terminal so it can ask its questions", () => {
    const box = sandbox("Darwin");
    const fakeEngine = temp.make("fake-engine-");
    writeFileSync(join(fakeEngine, "fleet"), `if [ -t 0 ]; then where=tty; else where=pipe; fi\necho "fleet $* stdin=$where" >> "${box.log}"\n`);
    git(fakeEngine, "init", "-q", "-b", "main");
    git(fakeEngine, "add", ".");
    git(fakeEngine, "commit", "-q", "-m", "fake engine");
    const command = `printf 'piped script\\n' | sh ${join(repoRoot, "get.sh")} --ref main -- --preset starter`;
    const env = { PATH: box.bin, HOME: box.home, SHELL: "/bin/sh", FLEET_ENGINE_REPO: fakeEngine, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const result = Bun.spawnSync([Bun.which("script") ?? "script", "-qec", command, "/dev/null"], { env, stdin: "ignore" });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(box.log, "utf8").split("\n")).toContain("fleet setup --preset starter stdin=tty");
  });

  test("installs the engine's packages in the engine directory", () => {
    const box = sandbox("Linux");
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    const engineDir = join(box.home, ".local/share/fleet/engine");
    const calls = result.calls.split("\n");
    expect(calls).toContain("bun install --frozen-lockfile --production");
    expect(calls).toContain(`bun install ran in ${engineDir}`);
    expect(git(engineDir, "status", "--porcelain")).toBe("");
  });

  test("stops with the installer's output when the engine's packages do not install", () => {
    const box = sandbox("Linux");
    box.stub("bun", `[ "$1" = install ] || exec "${process.execPath}" "$@"\necho "lockfile is out of date" >&2\nexit 1`);
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("lockfile is out of date");
    expect(result.output).toContain("Fleet: could not install the engine's packages in " + join(box.home, ".local/share/fleet/engine") + ".");
  });

  test("a second run changes nothing", () => {
    const box = sandbox("Linux");
    const dir = profile();
    expect(getSh(box, ["--ref", "v0.1.0", "--profile", dir]).code).toBe(0);
    const again = getSh(box, ["--ref", "v0.1.0", "--profile", dir]);
    expect(again.code).toBe(0);
    expect(again.output).toContain("Applied 0 changes.");
  });

  test("passes flags after -- to fleet and rejects others", () => {
    const box = sandbox("Linux");
    expect(getSh(box, ["--preset", "everyday"])).toMatchObject({ code: 1, output: expect.stringContaining("unknown option --preset. Put flags for fleet after --.") });
    const result = getSh(box, ["--ref", "v0.1.0", "--", "--preset", "nope"]);
    expect(result).toMatchObject({ code: 2, output: expect.stringContaining("fleet setup: --preset nope: choose starter, everyday, michael") });
  });
});

describe("get.sh with an existing engine directory", () => {
  test("refuses a directory that is not an engine, and an engine with local changes", () => {
    const box = sandbox("Linux");
    const engineDir = join(box.home, ".local/share/fleet/engine");
    mkdirSync(engineDir, { recursive: true });
    writeFileSync(join(engineDir, "notes.txt"), "mine\n");
    expect(getSh(box, ["--ref", "v0.1.0", "--profile", profile()])).toMatchObject({ code: 1, output: expect.stringContaining("holds files that are not a Fleet engine") });
    expect(readFileSync(join(engineDir, "notes.txt"), "utf8")).toBe("mine\n");

    const fresh = sandbox("Linux");
    expect(getSh(fresh, ["--ref", "v0.1.0", "--profile", profile()]).code).toBe(0);
    const installed = join(fresh.home, ".local/share/fleet/engine");
    writeFileSync(join(installed, "fleet"), "# my patch\n");
    expect(getSh(fresh, ["--ref", "v0.1.0", "--profile", profile()])).toMatchObject({ code: 1, output: expect.stringContaining("has local changes") });
    expect(readFileSync(join(installed, "fleet"), "utf8")).toBe("# my patch\n");
  });
});

describe("profile install.sh shim", () => {
  function shim(fleetJson: string, curl: string) {
    const box = sandbox("Linux");
    const dir = temp.make("profile-");
    writeFileSync(join(dir, "fleet.json"), fleetJson);
    cpSync(join(repoRoot, "templates/profile/install.sh"), join(dir, "install.sh"));
    writeFileSync(join(box.bin, "curl"), `#!/bin/sh\necho "curl $*" >> "${box.log}"\n${curl}\n`);
    const result = Bun.spawnSync(["sh", join(dir, "install.sh")], { cwd: box.home, env: { PATH: box.bin, HOME: box.home } });
    return { dir, code: result.exitCode, output: result.stderr.toString(), calls: existsSync(box.log) ? readFileSync(box.log, "utf8") : "" };
  }
  test("runs get.sh from the engine pin of compact JSON with the profile directory", () => {
    const json = '{"engine":{"repo":"Silthus/fleet-engine","ref":"v0.1.0","channel":"release"},"sources":[{"name":"team","repo":"me/team","ref":"v9.0.0"}]}';
    const box = sandbox("Linux");
    const dir = temp.make("profile-");
    writeFileSync(join(dir, "fleet.json"), json);
    cpSync(join(repoRoot, "templates/profile/install.sh"), join(dir, "install.sh"));
    writeFileSync(join(box.bin, "curl"), `#!/bin/sh\necho "curl $*" >> "${box.log}"\nwhile [ $# -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done\necho 'echo "get.sh $*" >> "${box.log}"' > "$out"\n`);
    const result = Bun.spawnSync(["sh", join(dir, "install.sh")], { cwd: box.home, env: { PATH: box.bin, HOME: box.home } });
    expect(result.exitCode).toBe(0);
    const calls = readFileSync(box.log, "utf8");
    expect(calls).toContain("curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/v0.1.0/get.sh -o ");
    expect(calls).toContain(`get.sh --ref v0.1.0 --profile ${dir}`);
  });

  test("fails when the download fails or the pin is missing", () => {
    const failed = shim('{"engine":{"ref":"v0.1.0"}}', "exit 22");
    expect(failed).toMatchObject({ code: 1, output: expect.stringContaining("could not download") });
    expect(shim('{"engine":{"repo":"x"}}', "exit 0")).toMatchObject({ code: 1, output: expect.stringContaining("needs an engine ref") });
  });
});
