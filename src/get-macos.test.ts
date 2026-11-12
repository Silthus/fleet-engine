import { describe, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./testing/git.ts";
import { getShHarness, onLinuxHost, repoRoot } from "./testing/get-sh.ts";

const { temp, sandbox, profile, getSh } = getShHarness();

describe("get.sh", () => {
  onLinuxHost("on macOS without the T3 Code app, installs Homebrew and the app, then applies the profile", () => {
    const box = sandbox("Darwin");
    const result = getSh(box, ["--ref", "v0.1.0", "--profile", profile()]);
    expect(result.code).toBe(0);
    const calls = result.calls.split("\n");
    expect(result.calls).toContain("Homebrew/install");
    expect(calls).toContain("brew install --cask t3-code");
    expect(calls.filter((call) => call.startsWith("brew install ") && !call.includes("--cask"))).toEqual([]);
    expect(result.calls).toContain("t3 installer channel=nightly");
    expect(result.output).toContain("Applied 14 changes.");
  });

  onLinuxHost("under curl | sh, gives the Homebrew installer the terminal so it can ask for the password", () => {
    const box = sandbox("Darwin");
    const command = `printf 'piped script\\n' | sh ${join(repoRoot, "get.sh")} --ref v0.1.0 --install-only`;
    const env = { ...box.env, SHELL: "/bin/sh" };
    const result = Bun.spawnSync([Bun.which("script") ?? "script", "-qec", command, "/dev/null"], { env, stdin: "ignore" });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(box.log, "utf8")).toContain("brew installer stdin=tty");
  });

  onLinuxHost("on macOS puts Homebrew's folders, /opt/homebrew/bin and /usr/local/bin, first on PATH", () => {
    const box = sandbox("Darwin");
    const seen = join(box.root, "seen-path");
    box.stub("xcode-select", `echo "$PATH" > "${seen}"; kill -TERM $PPID`);
    const { FLEET_HOMEBREW_BINS: _, ...env } = box.env;
    Bun.spawnSync(["sh", join(repoRoot, "get.sh"), "--ref", "v0.1.0", "--install-only"], { env, stdin: "ignore" });
    expect(readFileSync(seen, "utf8")).toStartWith("/opt/homebrew/bin:/usr/local/bin:");
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
    expect(readFileSync(join(box.home, ".local/state/fleet/logs/install-timings"), "utf8")).toMatch(/^tools \d+ needed-you$/m);
    const passed = calls.indexOf("xcode-select -p", 4);
    expect(passed).toBeGreaterThanOrEqual(0);
    expect(passed).toBeLessThan(calls.findIndex((call) => call.startsWith("curl ")));
  });

  onLinuxHost("on macOS with the T3 Code app, needs no Homebrew and nothing from the person", () => {
    const box = sandbox("Darwin", { t3App: true });
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("Installing Homebrew");
    expect(result.calls).not.toContain("Homebrew/install");
    expect(result.calls).not.toContain("brew ");
    expect(readFileSync(join(box.home, ".local/state/fleet/logs/install-timings"), "utf8")).toMatch(/^tools \d+$/m);
  });

  onLinuxHost.each([
    ["gh", { without: ["gh"] }, "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_macOS_amd64.zip", "gh checksum mismatch."],
    ["Bun", { without: ["bun"] }, "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-x64.zip", "Bun checksum mismatch."],
  ] as const)("on macOS downloads %s for the Mac's chip from its pinned release, and refuses a file that does not match the pinned checksum", (_tool, options, url, refusal) => {
    const box = sandbox("Darwin", { ...options, without: [...options.without], t3App: true });
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(1);
    expect(result.calls).toContain(` ${url} -o `);
    expect(result.output).toContain(`Fleet: ${refusal}`);
    expect(result.calls).not.toContain("brew ");
    expect(existsSync(join(box.home, ".local/share/fleet/engine"))).toBe(false);
  });

  onLinuxHost.each([
    ["gh", "https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_macOS_arm64.zip"],
    ["bun", "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-aarch64.zip"],
  ])("on an Apple silicon Mac whose shell runs under Rosetta, downloads the arm64 %s", (tool, url) => {
    const box = sandbox("Darwin", { without: [tool], t3App: true });
    box.stub("sysctl", '[ "$*" = "-n sysctl.proc_translated" ] && echo 1');
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.calls).toContain(` ${url} -o `);
    expect(result.calls).not.toMatch(/_macOS_amd64\.zip|bun-darwin-x64\.zip/);
  });

  onLinuxHost("on macOS without sha256sum, checks the pinned checksum with shasum", () => {
    const box = sandbox("Darwin", { without: ["gh", "sha256sum"], t3App: true });
    box.stub("shasum", `[ "$1 $2" = "-a 256" ] && exec ${Bun.which("sha256sum") ?? "/usr/bin/sha256sum"} "$3"`);
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.calls).toMatch(/^shasum -a 256 .*gh\.zip$/m);
    expect(result.output).toContain("Fleet: gh checksum mismatch.");
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
    const env = { ...box.env, SHELL: "/bin/sh", FLEET_ENGINE_REPO: fakeEngine };
    const result = Bun.spawnSync([Bun.which("script") ?? "script", "-qec", command, "/dev/null"], { env, stdin: "ignore" });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(box.log, "utf8").split("\n")).toContain("fleet setup --preset starter stdin=tty");
  });
});
