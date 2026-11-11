import { afterAll, afterEach, beforeAll, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, isolateGit, tempDirs } from "./git.ts";

export const repoRoot = join(import.meta.dir, "..", "..");
export const onLinuxHost = test.if(process.platform === "linux");

const systemTools = ["sh", "env", "id", "cat", "mkdir", "mktemp", "rm", "chmod", "dirname", "sed", "grep", "head", "install", "tar", "gzip", "git", "bun", "sha256sum", "tr", "tail", "ls", "cp", "mv", "basename", "sleep", "python3"];

type SandboxOptions = { without?: string[]; brewInstaller?: string; t3Failures?: number; releasesFeed?: string };
export type Sandbox = { root: string; bin: string; home: string; log: string; stub: (name: string, body: string) => void; failDownloads: (pattern: string, times: number) => void; stallDownloads: (pattern: string, times: number) => void };

const t3Feed = ["mobile-android-build%2F2.3.0%2Fabc", "v0.1.9-nightly.20990102.7", "v0.1.9-nightly.20990101.3"]
  .map((tag) => `<entry><link rel="alternate" type="text/html" href="https://github.com/pingdotgg/t3code/releases/tag/${tag}"/></entry>`)
  .join("\n");

export function getShHarness() {
  isolateGit();
  const temp = tempDirs();
  const shared = tempDirs();
  const engine = { repo: "" };
  afterEach(() => temp.cleanup());
  afterAll(() => shared.cleanup());
  beforeAll(() => {
    engine.repo = shared.make("engine-repo-");
    for (const path of ["src", "packs", "fleet", "package.json", "bun.lock", ".gitignore", "presets.json"]) cpSync(join(repoRoot, path), join(engine.repo, path), { recursive: true });
    git(engine.repo, "init", "-q", "-b", "main");
    git(engine.repo, "add", ".");
    git(engine.repo, "commit", "-q", "-m", "engine");
    git(engine.repo, "tag", "v0.1.0");
  });

  function sandbox(os: "Linux" | "Darwin", options: SandboxOptions = {}): Sandbox {
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
    stub("sleep", "exit 0");
    stub("claude", "exit 0");
    stub("codex", "exit 0");
    stub("npx", "exit 0");
    const t3Left = join(root, "t3-failures");
    writeFileSync(t3Left, String(options.t3Failures ?? 0));
    const t3Installer = `left=$(cat "${t3Left}"); echo "t3 installer channel=$T3CODE_CHANNEL version=$T3CODE_VERSION" >> "${log}"; if [ "$left" -gt 0 ]; then echo $((left - 1)) > "${t3Left}"; echo "GET https://api.github.com/repos/pingdotgg/t3code/releases returned HTTP 403" >&2; exit 1; fi; curl -sSL "https://github.com/pingdotgg/t3code/releases/download/v$T3CODE_VERSION/SHA256SUMS" -o "$HOME/.t3-sums" || exit 1; mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\necho "t3 $*" >> "${log}"\\n' > "$HOME/.local/bin/t3"; chmod +x "$HOME/.local/bin/t3"`;
    const feed = join(root, "releases.atom");
    writeFileSync(feed, options.releasesFeed ?? t3Feed);
    const failures = join(root, "failures");
    mkdirSync(failures);
    let rules = 0;
    const failDownloads = (pattern: string, times: number) => writeFileSync(join(failures, String(rules++)), `fail ${pattern} ${times}\n`);
    const stallDownloads = (pattern: string, times: number) => writeFileSync(join(failures, String(rules++)), `stall ${pattern} ${times}\n`);
    const brewInstaller = options.brewInstaller ?? `printf '#!/bin/sh\\necho "brew $*" >> "${log}"\\n[ "$2" = gh ] && printf "#!/bin/sh\\\\n" > "${bin}/gh" && chmod +x "${bin}/gh"\\nexit 0\\n' > "${bin}/brew"; chmod +x "${bin}/brew"; [ -t 0 ] && echo "brew installer stdin=tty" >> "${log}"; true`;
    const ghTar = buildGhTarball(root);
    stub("curl", `
out=; url=; effective=; connect=0; floor=0; window=0
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; -w) effective=1; shift ;; --connect-timeout) connect=$2; shift ;; --speed-limit) floor=$2; shift ;; --speed-time) window=$2; shift ;; -*) ;; *) url=$1 ;; esac; shift; done
bounded=; [ "$connect" -gt 0 ] && [ "$floor" -gt 0 ] && [ "$window" -gt 0 ] && bounded=1
[ -n "$bounded" ] || echo "curl hangs on $url: no connect timeout or stall limit" >> "${log}"
for rule in "${failures}"/*; do
  [ -f "$rule" ] || continue
  read -r kind pattern left < "$rule"
  case "$url" in $pattern) if [ "$left" -gt 0 ]; then
    echo "$kind $pattern $((left - 1))" > "$rule"
    [ "$kind" = stall ] || { echo "curl: (22) The requested URL returned error: 503" >&2; exit 22; }
    [ -n "$bounded" ] || exit 99
    echo "curl: (28) Operation too slow." >&2; exit 28
  fi ;; esac
done
case "$url" in
  https://github.com/pingdotgg/t3code/releases.atom) cat "${feed}" ;;
  https://github.com/pingdotgg/t3code/releases/download/*/SHA256SUMS) echo sums > "$out" ;;
  https://t3.codes/install.sh) echo '${t3Installer.replaceAll("'", "'\\''")}' > "$out" ;;
  https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh) echo '${brewInstaller.replaceAll("'", "'\\''")}' > "$out" ;;
  https://github.com/cli/cli/releases/latest) printf 'https://github.com/cli/cli/releases/tag/v9.9.9' ;;
  *gh_9.9.9_linux_amd64.tar.gz) cp "${ghTar}" "$out" ;;
  *gh_9.9.9_checksums.txt) echo "$(sha256sum "${ghTar}" | cut -c1-64)  gh_9.9.9_linux_amd64.tar.gz" > "$out" ;;
  *) echo "unexpected url $url" >&2; exit 22 ;;
esac`);
    symlinkSync(Bun.which("cut") ?? "/usr/bin/cut", join(bin, "cut"));
    return { root, bin, home, log, stub, failDownloads, stallDownloads };
  }

  function profile() {
    const dir = temp.make("profile-");
    writeFileSync(join(dir, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "v0.1.0", channel: "release" }, sources: [], packs: [], plan: "both", settings: {}, workflows: {} }, null, 2));
    return dir;
  }

  function getSh(box: Sandbox, args: string[], options: { env?: Record<string, string>; cwd?: string } = {}) {
    const result = Bun.spawnSync(["sh", join(repoRoot, "get.sh"), ...args], {
      env: { PATH: box.bin, HOME: box.home, FLEET_ENGINE_REPO: engine.repo, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...options.env },
      cwd: options.cwd,
      stdin: "ignore",
    });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString(), calls: existsSync(box.log) ? readFileSync(box.log, "utf8") : "" };
  }

  return { temp, engine, sandbox, profile, getSh };
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
