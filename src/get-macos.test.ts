import { describe, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./testing/git.ts";
import { getShHarness, onLinuxHost, repoRoot } from "./testing/get-sh.ts";

const { temp, engine, sandbox, profile, getSh } = getShHarness();

describe("get.sh", () => {
  onLinuxHost("on macOS installs Homebrew, gh, and the T3 Code app, then applies the profile", () => {
    const box = sandbox("Darwin");
    const result = getSh(box, ["--ref", "v0.1.0", "--profile", profile()]);
    expect(result.code).toBe(0);
    const calls = result.calls.split("\n");
    expect(calls.indexOf("brew install gh")).toBeGreaterThan(-1);
    expect(calls).toContain("brew install --cask t3-code");
    expect(calls).not.toContain("brew install bun");
    expect(result.calls).toContain("t3 installer channel=nightly");
    expect(result.output).toContain("Applied 14 changes.");
  });

  onLinuxHost("under curl | sh, gives the Homebrew installer the terminal so it can ask for the password", () => {
    const box = sandbox("Darwin");
    const command = `printf 'piped script\\n' | sh ${join(repoRoot, "get.sh")} --ref v0.1.0 --install-only`;
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
});
