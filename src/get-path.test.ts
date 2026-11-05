import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getShHarness, onLinuxHost } from "./testing/get-sh.ts";

const { sandbox, getSh } = getShHarness();

describe("fleet on the PATH", () => {
  test("puts fleet into ~/.local/bin, where it runs the engine even from a directory it cannot read", () => {
    const box = sandbox("Linux");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    const fleet = join(box.home, ".local/bin/fleet");
    const unreadable = join(box.root, "unreadable");
    mkdirSync(unreadable, { mode: 0o100 });
    const result = Bun.spawnSync([fleet, "--help"], { cwd: unreadable, env: { PATH: box.bin, HOME: box.home } });
    chmodSync(unreadable, 0o700);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toStartWith("Fleet: one setup for T3 Code, agents, and your workflows");
    expect(result.exitCode).toBe(0);
  });

  test("on Linux adds the PATH line to ~/.profile once and keeps the lines already there", () => {
    const box = sandbox("Linux");
    writeFileSync(join(box.home, ".profile"), "umask 022\n");
    const first = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    const second = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(readFileSync(join(box.home, ".profile"), "utf8")).toBe('umask 022\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" # Added by Fleet\n');
    expect(first.output).toContain("Fleet: Open a new terminal to use fleet. ~/.profile now puts ~/.local/bin and ~/.bun/bin on your PATH.");
    expect(second.output).not.toContain("Open a new terminal");
  });

  test("on Linux uses ~/.bash_profile when it exists, because bash then skips ~/.profile", () => {
    const box = sandbox("Linux");
    writeFileSync(join(box.home, ".bash_profile"), ". ~/.bashrc\n");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { SHELL: "/bin/bash" } }).code).toBe(0);
    expect(readFileSync(join(box.home, ".bash_profile"), "utf8")).toEndWith('export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" # Added by Fleet\n');
    expect(existsSync(join(box.home, ".profile"))).toBe(false);
  });

  onLinuxHost("on macOS adds the PATH line, with Homebrew's bin, to ~/.zprofile once", () => {
    const box = sandbox("Darwin");
    box.stub("brew", "exit 0");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    expect(readFileSync(join(box.home, ".zprofile"), "utf8")).toBe('export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:$PATH" # Added by Fleet\n');
    expect(existsSync(join(box.home, ".profile"))).toBe(false);
  });

  test("replaces its own fleet in ~/.local/bin and leaves another fleet there alone", () => {
    const box = sandbox("Linux");
    const fleet = join(box.home, ".local/bin/fleet");
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    writeFileSync(fleet, "#!/bin/sh\n# Fleet\nexit 3\n");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    expect(readFileSync(fleet, "utf8")).toBe(`#!/bin/sh\n# Fleet\nexec sh '${join(box.home, ".local/share/fleet/engine/fleet")}' "$@"\n`);
    writeFileSync(fleet, "#!/bin/sh\necho someone else's fleet\n");
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(readFileSync(fleet, "utf8")).toBe("#!/bin/sh\necho someone else's fleet\n");
    const engine = join(box.home, ".local/share/fleet/engine/fleet");
    expect(result.output).toContain(`Fleet: ${fleet} is not Fleet's, so it stays as it is. Run Fleet with sh ${engine}.\n`);
    expect(readdirSync(join(box.home, ".local/bin")).sort()).toEqual(["fleet", "gh", "t3"]);
  });

  test("writes a fleet that works from any directory when FLEET_ENGINE_DIR is relative", () => {
    const box = sandbox("Linux");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { FLEET_ENGINE_DIR: "engine" }, cwd: box.root }).code).toBe(0);
    const result = Bun.spawnSync([join(box.home, ".local/bin/fleet"), "--help"], { cwd: box.home, env: { PATH: box.bin, HOME: box.home } });
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toStartWith("Fleet: one setup for T3 Code, agents, and your workflows");
  });

  test("with bash as the login shell, uses ~/.bash_login when it exists and ~/.bash_profile does not, and starts the PATH line on a new line", () => {
    const box = sandbox("Linux");
    writeFileSync(join(box.home, ".bash_login"), "# existing comment");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { SHELL: "/usr/bin/bash" } }).code).toBe(0);
    expect(readFileSync(join(box.home, ".bash_login"), "utf8")).toBe('# existing comment\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" # Added by Fleet\n');
    expect(existsSync(join(box.home, ".profile"))).toBe(false);
    const login = Bun.spawnSync([Bun.which("bash") ?? "bash", "-lc", "command -v fleet"], { env: { PATH: "/usr/bin:/bin", HOME: box.home } });
    expect(login.stdout.toString().trim()).toBe(join(box.home, ".local/bin/fleet"));
  });

  test.if(Bun.which("zsh") !== null)("on Linux with zsh as the login shell, a new zsh login shell finds fleet through ~/.zprofile", () => {
    const box = sandbox("Linux");
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { SHELL: "/usr/bin/zsh" } }).code).toBe(0);
    expect(readFileSync(join(box.home, ".zprofile"), "utf8")).toBe('export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" # Added by Fleet\n');
    expect(existsSync(join(box.home, ".profile"))).toBe(false);
    const login = Bun.spawnSync([Bun.which("zsh") ?? "zsh", "-lc", "command -v fleet"], { env: { PATH: "/usr/bin:/bin", HOME: box.home } });
    expect(login.stdout.toString().trim()).toBe(join(box.home, ".local/bin/fleet"));
  });

  test("with fish as the login shell, writes its own fish file once", () => {
    const box = sandbox("Linux");
    const first = getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { SHELL: "/usr/bin/fish" } });
    const second = getSh(box, ["--ref", "v0.1.0", "--install-only"], { env: { SHELL: "/usr/bin/fish" } });
    expect(readFileSync(join(box.home, ".config/fish/conf.d/fleet.fish"), "utf8")).toBe("fish_add_path --global $HOME/.local/bin $HOME/.bun/bin\n");
    expect(existsSync(join(box.home, ".profile"))).toBe(false);
    expect(first.output).toContain("Fleet: Open a new terminal to use fleet. ~/.config/fish/conf.d/fleet.fish now puts ~/.local/bin and ~/.bun/bin on your PATH.");
    expect(second.output).not.toContain("Open a new terminal");
  });
});
