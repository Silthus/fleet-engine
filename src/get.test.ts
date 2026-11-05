import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, isolateGit, tempDirs } from "./testing/git.ts";

isolateGit();
const temp = tempDirs();
const shared = tempDirs();
afterEach(() => temp.cleanup());
afterAll(() => shared.cleanup());

const repoRoot = join(import.meta.dir, "..");
const systemTools = ["sh", "env", "id", "cat", "mkdir", "mktemp", "rm", "chmod", "dirname", "sed", "grep", "head", "install", "tar", "gzip", "git", "bun", "sha256sum", "tr", "ls", "cp", "mv", "basename", "sleep", "python3"];
let engineRepo: string;

beforeAll(() => {
  engineRepo = shared.make("engine-repo-");
  for (const path of ["src", "packs", "fleet", "package.json", "bun.lock", ".gitignore", "presets.json"]) cpSync(join(repoRoot, path), join(engineRepo, path), { recursive: true });
  git(engineRepo, "init", "-q", "-b", "main");
  git(engineRepo, "add", ".");
  git(engineRepo, "commit", "-q", "-m", "engine");
  git(engineRepo, "tag", "v0.1.0");
});

type SandboxOptions = { without?: string[]; brewInstaller?: string };

const onLinuxHost = test.if(process.platform === "linux");

function sandbox(os: "Linux" | "Darwin", options: SandboxOptions = {}) {
  const root = temp.make("get-");
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  for (const tool of systemTools.filter((name) => !options.without?.includes(name))) symlinkSync(Bun.which(tool) ?? `/missing/${tool}`, join(bin, tool));
  const log = join(root, "calls.log");
  const stub = (name: string, body: string) => {
    rmSync(join(bin, name), { force: true });
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("uname", `case "$1" in -s) echo ${os} ;; -m) echo x86_64 ;; esac`);
  writeFileSync(join(root, "fake-bun"), `#!/bin/sh\necho "bun $*" >> "${log}"\n${fakeBun(log)}\n`);
  chmodSync(join(root, "fake-bun"), 0o755);
  if (!options.without?.includes("bun")) cpSync(join(root, "fake-bun"), join(bin, "bun"));
  stub("xcode-select", "exit 0");
  stub("claude", "exit 0");
  stub("codex", "exit 0");
  const t3Installer = `printf '#!/bin/sh\\necho "t3 $*" >> "${log}"\\n' > "$HOME/.local/bin/t3"; chmod +x "$HOME/.local/bin/t3"; echo "t3 installer channel=$T3CODE_CHANNEL" >> "${log}"`;
  const brewInstaller = options.brewInstaller ?? `printf '#!/bin/sh\\necho "brew $*" >> "${log}"\\n[ "$2" = gh ] && printf "#!/bin/sh\\\\n" > "${bin}/gh" && chmod +x "${bin}/gh"\\nexit 0\\n' > "${bin}/brew"; chmod +x "${bin}/brew"; [ -t 0 ] && echo "brew installer stdin=tty" >> "${log}"; true`;
  const ghTar = buildGhTarball(root);
  stub("curl", `
out=; url=; effective=
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; -w) effective=1; shift ;; -*) ;; *) url=$1 ;; esac; shift; done
case "$url" in
  https://t3.codes/install.sh) echo '${t3Installer.replaceAll("'", "'\\''")}' > "$out" ;;
  https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh) echo '${brewInstaller.replaceAll("'", "'\\''")}' > "$out" ;;
  https://github.com/cli/cli/releases/latest) printf 'https://github.com/cli/cli/releases/tag/v9.9.9' ;;
  *gh_9.9.9_linux_amd64.tar.gz) cp "${ghTar}" "$out" ;;
  *gh_9.9.9_checksums.txt) echo "$(sha256sum "${ghTar}" | cut -c1-64)  gh_9.9.9_linux_amd64.tar.gz" > "$out" ;;
  *) echo "unexpected url $url" >&2; exit 22 ;;
esac`);
  symlinkSync(Bun.which("cut") ?? "/usr/bin/cut", join(bin, "cut"));
  return { root, bin, home, log, stub };
}

function fakeBun(log: string) {
  return `[ "$1" = install ] || exec "${process.execPath}" "$@"
echo "bun install ran in $PWD" >> "${log}"
mkdir -p node_modules && "${Bun.which("ln") ?? "ln"}" -sfn "${join(repoRoot, "node_modules", "smol-toml")}" node_modules/smol-toml`;
}

function buildGhTarball(root: string) {
  const dir = join(root, "gh-build", "gh_9.9.9_linux_amd64", "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "gh"), 0o755);
  const tarball = join(root, "gh.tar.gz");
  Bun.spawnSync(["tar", "-czf", tarball, "-C", join(root, "gh-build"), "gh_9.9.9_linux_amd64"]);
  return tarball;
}

function profile() {
  const dir = temp.make("profile-");
  writeFileSync(join(dir, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "v0.1.0", channel: "release" }, sources: [], packs: [], plan: "both", settings: {}, workflows: {} }, null, 2));
  return dir;
}

function getSh(box: ReturnType<typeof sandbox>, args: string[]) {
  const result = Bun.spawnSync(["sh", join(repoRoot, "get.sh"), ...args], {
    env: { PATH: box.bin, HOME: box.home, FLEET_ENGINE_REPO: engineRepo, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdin: "ignore",
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString(), calls: existsSync(box.log) ? readFileSync(box.log, "utf8") : "" };
}

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
    const env = { PATH: box.bin, HOME: box.home, SHELL: "/bin/sh", FLEET_ENGINE_REPO: engineRepo, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
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
    expect(getSh(box, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
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
