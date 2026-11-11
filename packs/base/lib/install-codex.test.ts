import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const onLinux = test.skipIf(process.platform !== "linux");
const script = join(import.meta.dir, "install-codex.sh");
const tag = "rust-v9.9.9";
const realMv = Bun.which("mv") ?? "/bin/mv";
const realReadlink = Bun.which("readlink") ?? "/bin/readlink";
const realFlock = Bun.which("flock") ?? "/usr/bin/flock";

function stub(bin: string, name: string, body: string, keep?: string) {
  if (keep) copyFileSync(join(bin, name), keep);
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${join(bin, "calls.log")}"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

const packages = new Map<string, Promise<{ code: number; bytes: Uint8Array }>>();

function packaged(name: string, target: string) {
  const key = `${name} ${target}`;
  if (!packages.has(key)) packages.set(key, (async () => {
    const tree = temp.make("package-");
    mkdirSync(join(tree, "bin"));
    writeFileSync(join(tree, "bin", "codex"), `#!/bin/sh\n[ ! -e /proc/$$/fd/9 ] || : > "$HOME/codex-saw-lock"\necho "codex-cli ${name.replace("rust-v", "")} ${target}"\n`);
    chmodSync(join(tree, "bin", "codex"), 0o755);
    const archive = join(tree, "package.tar.gz");
    const code = await Bun.spawn(["tar", "-czf", archive, "-C", tree, "bin"]).exited;
    return { code, bytes: code === 0 ? readFileSync(archive) : new Uint8Array() };
  })());
  return packages.get(key)!;
}

async function release(root: string, targets: string[], options: { tag?: string; corrupt?: boolean } = {}) {
  const name = options.tag ?? tag;
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const sums: string[] = [];
  for (const target of targets) {
    const asset = `codex-package-${target}.tar.gz`;
    const archive = await packaged(name, target);
    expect(archive.code).toBe(0);
    writeFileSync(join(dir, asset), archive.bytes);
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, asset))).digest("hex");
    sums.push(`${options.corrupt ? "0".repeat(64) : digest}  ${asset}`);
  }
  writeFileSync(join(dir, "codex-package_SHA256SUMS"), `${sums.join("\n")}\n`);
  writeFileSync(join(root, "latest"), name);
}

async function machine(arch: string, targets: string[], options: { corrupt?: boolean; os?: string } = {}) {
  const bin = temp.make("bin-");
  const home = temp.make("home-");
  const root = temp.make("releases-");
  await release(root, targets, options);
  stub(bin, "uname", `case "$1" in -s) echo ${options.os ?? "Linux"} ;; *) echo ${arch} ;; esac`);
  stub(
    bin,
    "curl",
    [
      "out='' url='' effective=''",
      'while [ "$#" -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -w) effective=1; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done',
      `latest=$(cat "${root}/latest")`,
      `[ -z "$effective" ] || { printf '%s' "https://github.com/openai/codex/releases/tag/$latest"; exit 0; }`,
      `[ ! -f "${bin}/term-on-download" ] || case "$url" in *.tar.gz) kill -TERM "$PPID"; exit 22 ;; esac`,
      'case "$url" in https://github.com/openai/codex/releases/download/*) ;; *) exit 22 ;; esac',
      'rest=${url#https://github.com/openai/codex/releases/download/}',
      `file="${root}/$rest"`,
      '[ -f "$file" ] || exit 22',
      'cp "$file" "$out"',
    ].join("\n"),
  );
  stub(bin, "bun", 'case "$*" in "remove -g @openai/codex") rm -rf "$HOME/.bun/bin/codex" "$HOME/.bun/install/global/node_modules/@openai/codex" ;; esac');
  return {
    bin,
    home,
    publish: (name: string) => release(root, [targets[0] ?? ""], { tag: name }),
    calls: () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8") : ""),
  };
}

async function install(box: { bin: string; home: string }, path = `${box.bin}:${box.home}/.local/bin:/usr/bin:/bin`, env: Record<string, string> = {}) {
  const child = Bun.spawn(["/bin/sh", script], { env: { HOME: box.home, PATH: path, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

async function version(home: string) {
  const child = Bun.spawn([join(home, ".local/bin/codex"), "--version"], { stdout: "pipe", stderr: "pipe" });
  return (await new Response(child.stdout).text()).trim();
}

const codexHome = (home: string) => join(home, ".local/share/fleet/codex");

describe("install-codex.sh", () => {
  onLinux.each([
    ["x86_64", "x86_64-unknown-linux-musl"],
    ["aarch64", "aarch64-unknown-linux-musl"],
  ])("installs the checked release package for %s into ~/.local/bin", async (arch, target) => {
    const box = await machine(arch, ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"]);
    expect(await install(box)).toMatchObject({ code: 0 });
    expect(await version(box.home)).toBe(`codex-cli 9.9.9 ${target}`);
    expect(readlinkSync(join(box.home, ".local/bin/codex"))).toBe(join(codexHome(box.home), "current/bin/codex"));
    expect(readlinkSync(join(codexHome(box.home), "current"))).toBe(`releases/${tag}`);
    expect(box.calls()).toContain(`/releases/download/${tag}/codex-package-${target}.tar.gz`);
    expect(box.calls()).not.toContain("bun ");
  });

  onLinux("leaves the same release alone when it runs again", async () => {
    const box = await machine("x86_64", ["x86_64-unknown-linux-musl"]);
    expect((await install(box)).code).toBe(0);
    const installed = statSync(join(codexHome(box.home), "releases", tag, "bin/codex")).ino;
    const again = await install(box);
    expect(again).toMatchObject({ code: 0, stdout: "codex-cli 9.9.9 x86_64-unknown-linux-musl\n" });
    expect(box.calls().split("\n").filter((line) => line.includes(".tar.gz"))).toHaveLength(1);
    expect(statSync(join(codexHome(box.home), "releases", tag, "bin/codex")).ino).toBe(installed);
    expect(readdirSync(join(codexHome(box.home), "releases"))).toEqual([tag]);
    expect(await version(box.home)).toBe("codex-cli 9.9.9 x86_64-unknown-linux-musl");
  });

  onLinux("keeps the previous release for running sessions and removes older ones", async () => {
    const box = await machine("x86_64", ["x86_64-unknown-linux-musl"]);
    expect((await install(box)).code).toBe(0);
    await box.publish("rust-v10.0.0");
    expect((await install(box)).code).toBe(0);
    await box.publish("rust-v10.1.0");
    expect((await install(box)).code).toBe(0);
    expect(await version(box.home)).toBe("codex-cli 10.1.0 x86_64-unknown-linux-musl");
    expect(readdirSync(join(codexHome(box.home), "releases")).sort()).toEqual(["rust-v10.0.0", "rust-v10.1.0"]);
    expect(readdirSync(codexHome(box.home)).sort()).toEqual(["current", "releases"]);
  });

  onLinux.each([
    ["Linux", "x86_64", "x86_64-unknown-linux-musl"],
    ["Darwin", "arm64", "aarch64-apple-darwin"],
  ])("on %s, holds one install lock from before it reads the old install until it has pruned, and passes it to no Codex it starts", async (os, arch, target) => {
    const box = await machine(arch, [target], { os });
    if (os === "Darwin") onMac(box);
    expect((await install(box)).code).toBe(0);
    await box.publish("rust-v10.0.0");
    expect((await install(box)).code).toBe(0);
    await box.publish("rust-v10.1.0");
    const log = join(box.bin, "calls.log");
    writeFileSync(log, "");
    const lock = join(box.home, ".local/share/fleet/codex.lock");
    const held = (name: string) => `if ${realFlock} -n "${lock}" true; then echo "${name} free" >> "${log}"; else echo "${name} locked" >> "${log}"; fi`;
    stub(box.bin, "readlink", `${held("readlink")}\nexec ${realReadlink} "$@"`);
    stub(box.bin, "rm", `${held("rm")}\nexec ${Bun.which("rm") ?? "/bin/rm"} "$@"`);
    stub(box.bin, "curl", `${held("curl")}\nexec ${join(box.bin, "curl.real")} "$@"`, join(box.bin, "curl.real"));
    expect((await install(box)).code).toBe(0);
    const lines = box.calls().split("\n");
    const checks = lines.filter((line) => / (free|locked)$/.test(line));
    const firstRead = checks.findIndex((line) => line.startsWith("readlink "));
    const pruned = lines.findIndex((line) => line === `rm -rf ${join(codexHome(box.home), "releases", tag)}`);
    expect(firstRead).toBeGreaterThan(-1);
    expect(pruned).toBeGreaterThan(-1);
    expect(lines[pruned + 1]).toBe("rm locked");
    expect(checks.filter((line) => line.startsWith("readlink ") || line.startsWith("curl "))).toSatisfy((all) => all.length > 0 && all.every((line) => line.endsWith(" locked")));
    expect(Bun.spawnSync([realFlock, "-n", lock, "true"]).exitCode).toBe(0);
    expect(existsSync(join(box.home, "codex-saw-lock"))).toBe(false);
    expect(readdirSync(join(codexHome(box.home), "releases")).sort()).toEqual(["rust-v10.0.0", "rust-v10.1.0"]);
  });

  onLinux("refuses to install without flock", async () => {
    const box = await machine("x86_64", ["x86_64-unknown-linux-musl"]);
    const result = await install(box, box.bin);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("needs flock");
    expect(box.calls()).not.toContain("curl");
  });

  onLinux("takes a release another install already published instead of nesting it", async () => {
    const box = await machine("x86_64", ["x86_64-unknown-linux-musl"]);
    const final = join(codexHome(box.home), "releases", tag);
    stub(
      box.bin,
      "mv",
      `for arg; do case "$arg" in */codex-new.*/package) mkdir -p "${final}/bin" && cp "$arg/bin/codex" "${final}/bin/codex" ;; esac; done\nexec ${realMv} "$@"`,
    );
    expect(await install(box)).toMatchObject({ code: 0, stdout: "codex-cli 9.9.9 x86_64-unknown-linux-musl\n" });
    expect(readdirSync(final)).toEqual(["bin"]);
    expect(await version(box.home)).toBe("codex-cli 9.9.9 x86_64-unknown-linux-musl");
    expect(readdirSync(join(box.home, ".local/share/fleet")).filter((name) => name.startsWith("codex-new."))).toEqual([]);
  });

  onLinux.each([["ls's default quoting", {}], ["QUOTING_STYLE=c", { QUOTING_STYLE: "c" }]] as const)("keeps a release while a session still runs from it, with %s", async (_quoting, env) => {
    const box = await machine("x86_64", ["x86_64-unknown-linux-musl"]);
    expect((await install(box, undefined, env)).code).toBe(0);
    const old = join(codexHome(box.home), "releases", tag);
    copyFileSync("/bin/sh", join(old, "bin/codex"));
    const session = Bun.spawn([join(old, "bin/codex"), "-c", "echo ready; read line"], { stdin: "pipe", stdout: "pipe" });
    try {
      const reader = session.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
      await box.publish("rust-v10.0.0");
      expect((await install(box, undefined, env)).code).toBe(0);
      await box.publish("rust-v10.1.0");
      expect((await install(box, undefined, env)).code).toBe(0);
      expect(readdirSync(join(codexHome(box.home), "releases")).sort()).toEqual(["rust-v10.0.0", "rust-v10.1.0", tag]);
    } finally {
      session.kill();
      await session.exited;
    }
    await box.publish("rust-v10.2.0");
    expect((await install(box, undefined, env)).code).toBe(0);
    expect(readdirSync(join(codexHome(box.home), "releases")).sort()).toEqual(["rust-v10.1.0", "rust-v10.2.0"]);
  });

  onLinux.each([
    ["the move of the new release", "exit 1"],
    ["the switch to the new release", `case "$*" in *"/current.new."*) exit 1 ;; esac; exec ${realMv} "$@"`],
  ])("keeps the old install working when %s fails", async (_step, mvBody) => {
    const box = await machine("x86_64", ["x86_64-unknown-linux-musl"]);
    expect((await install(box)).code).toBe(0);
    await box.publish("rust-v10.0.0");
    stub(box.bin, "mv", mvBody);
    expect((await install(box)).code).not.toBe(0);
    expect(await version(box.home)).toBe("codex-cli 9.9.9 x86_64-unknown-linux-musl");
    expect(readlinkSync(join(codexHome(box.home), "current"))).toBe(`releases/${tag}`);
    expect(readdirSync(join(box.home, ".local/bin"))).toEqual(["codex"]);
    expect(readdirSync(join(box.home, ".local/share/fleet")).filter((name) => name.startsWith("codex-new."))).toEqual([]);
  });

  onLinux("removes its partial download when it is stopped", async () => {
    const box = await machine("x86_64", ["x86_64-unknown-linux-musl"]);
    writeFileSync(join(box.bin, "term-on-download"), "");
    const result = await install(box);
    expect(result.code).not.toBe(0);
    expect(readdirSync(join(box.home, ".local/share/fleet"))).toEqual(["codex.lock"]);
    expect(existsSync(join(box.home, ".local/bin/codex"))).toBe(false);
  });

  onLinux("moves an install from the earlier single-folder layout without breaking it", async () => {
    const box = await machine("x86_64", ["x86_64-unknown-linux-musl"]);
    const legacy = codexHome(box.home);
    mkdirSync(join(legacy, "bin"), { recursive: true });
    writeFileSync(join(legacy, "bin/codex"), "#!/bin/sh\necho codex-cli 0.1.0\n");
    chmodSync(join(legacy, "bin/codex"), 0o755);
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    symlinkSync(join(legacy, "bin/codex"), join(box.home, ".local/bin/codex"));
    expect((await install(box)).code).toBe(0);
    expect(await version(box.home)).toBe("codex-cli 9.9.9 x86_64-unknown-linux-musl");
    expect(existsSync(join(legacy, "bin/codex"))).toBe(true);
    await box.publish("rust-v10.0.0");
    expect((await install(box)).code).toBe(0);
    expect(readdirSync(legacy).sort()).toEqual(["current", "releases"]);
    expect(readdirSync(join(legacy, "releases")).sort()).toEqual(["rust-v10.0.0", tag]);
  });

  onLinux("refuses a machine with no Codex build, before it downloads anything", async () => {
    const box = await machine("riscv64", ["x86_64-unknown-linux-musl"]);
    const result = await install(box);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no Codex build for riscv64");
    expect(box.calls()).not.toContain("curl");
  });

  onLinux("refuses a download that does not match its checksum", async () => {
    const box = await machine("aarch64", ["aarch64-unknown-linux-musl"], { corrupt: true });
    const result = await install(box);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not match its checksum");
    expect(existsSync(join(box.home, ".local/bin/codex"))).toBe(false);
    expect(existsSync(join(codexHome(box.home), "releases", tag))).toBe(false);
  });

  onLinux("keeps a codex in ~/.local/bin that Fleet did not install", async () => {
    const box = await machine("x86_64", ["x86_64-unknown-linux-musl"]);
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    writeFileSync(join(box.home, ".local/bin/codex"), "mine\n");
    const result = await install(box);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Fleet did not install it");
    expect(readFileSync(join(box.home, ".local/bin/codex"), "utf8")).toBe("mine\n");
  });

  function onMac(box: { bin: string }, running = "/usr/bin/login") {
    stub(box.bin, "lsof", `[ "$*" = "-nP -w -u $(id -u) -d txt -Fn" ] && printf 'p1\\nftxt\\nn%s\\n' "${running}"`);
    stub(box.bin, "flock", "exit 1");
    stub(box.bin, "sha256sum", "exit 127");
    stub(box.bin, "mv", `case "$1" in -T) echo "mv: illegal option -- T" >&2; exit 64 ;; -h) shift; exec ${realMv} -T "$@" ;; esac\nexec ${realMv} "$@"`);
  }

  onLinux.each([
    ["arm64", "aarch64-apple-darwin"],
    ["x86_64", "x86_64-apple-darwin"],
  ])("on a %s Mac, installs and updates the checked macOS package with the Mac's own mv and shasum", async (arch, target) => {
    const box = await machine(arch, [target], { os: "Darwin" });
    onMac(box);
    expect(await install(box)).toMatchObject({ code: 0 });
    expect(await version(box.home)).toBe(`codex-cli 9.9.9 ${target}`);
    await box.publish("rust-v10.0.0");
    expect((await install(box)).code).toBe(0);
    expect(readlinkSync(join(codexHome(box.home), "current"))).toBe("releases/rust-v10.0.0");
    expect(readlinkSync(join(box.home, ".local/bin/codex"))).toBe(join(codexHome(box.home), "current/bin/codex"));
    expect(box.calls()).not.toContain("flock");
    expect(box.calls()).not.toContain("sha256sum");
    expect(readdirSync(join(box.home, ".local/share/fleet")).sort()).toEqual(["codex", "codex.lock"]);
  });

  onLinux("on an Apple silicon Mac whose shell runs under Rosetta, installs the arm64 package", async () => {
    const box = await machine("x86_64", ["x86_64-apple-darwin", "aarch64-apple-darwin"], { os: "Darwin" });
    onMac(box);
    stub(box.bin, "sysctl", '[ "$*" = "-n sysctl.proc_translated" ] && echo 1');
    expect((await install(box)).code).toBe(0);
    expect(await version(box.home)).toBe("codex-cli 9.9.9 aarch64-apple-darwin");
  });

  onLinux("on a Mac, waits for an install that holds the lock", async () => {
    const box = await machine("arm64", ["aarch64-apple-darwin"], { os: "Darwin" });
    onMac(box);
    const share = join(box.home, ".local/share/fleet");
    mkdirSync(share, { recursive: true });
    const lock = join(share, "codex.lock");
    writeFileSync(lock, "");
    const holder = Bun.spawn([realFlock, lock, "sh", "-c", "echo held; read line"], { stdin: "pipe", stdout: "pipe" });
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");
    const waiter = new RegExp(`-> FLOCK .* [0-9a-f]+:[0-9a-f]+:${statSync(lock).ino} `);
    let finished = false;
    const waiting = install(box).then((result) => {
      finished = true;
      return result;
    });
    let blocked = false;
    try {
      for (let polls = 0; polls < 2000 && !finished && !blocked; polls++) {
        blocked = waiter.test(readFileSync("/proc/locks", "utf8"));
        if (!blocked) await Bun.sleep(5);
      }
    } finally {
      holder.stdin.end();
      await holder.exited;
    }
    expect(blocked).toBe(true);
    expect((await waiting).code).toBe(0);
  });

  onLinux("on a Mac, still holds the lock when descriptors 3 to 8 are already open", async () => {
    const box = await machine("arm64", ["aarch64-apple-darwin"], { os: "Darwin" });
    onMac(box);
    const lock = join(box.home, ".local/share/fleet/codex.lock");
    stub(box.bin, "curl", `if ${realFlock} -n "${lock}" true; then echo "curl free" >> "${join(box.bin, "calls.log")}"; fi\nexec ${join(box.bin, "curl.real")} "$@"`, join(box.bin, "curl.real"));
    const busy = Array.from({ length: 6 }, (_, index) => `${index + 3}</dev/null`).join(" ");
    const child = Bun.spawn(["/bin/sh", "-c", `exec ${busy}; exec /bin/sh "$0"`, script], { env: { HOME: box.home, PATH: `${box.bin}:${box.home}/.local/bin:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(box.calls()).toContain("curl ");
    expect(box.calls()).not.toContain("curl free");
  });

  onLinux("on a Mac, keeps an older release that a running Codex uses, and prunes nothing when it cannot list every running program", async () => {
    const box = await machine("arm64", ["aarch64-apple-darwin"], { os: "Darwin" });
    onMac(box, join(codexHome(box.home), "releases", tag, "bin/codex"));
    expect((await install(box)).code).toBe(0);
    await box.publish("rust-v10.0.0");
    expect((await install(box)).code).toBe(0);
    await box.publish("rust-v10.1.0");
    expect((await install(box)).code).toBe(0);
    expect(readdirSync(join(codexHome(box.home), "releases")).sort()).toEqual(["rust-v10.0.0", "rust-v10.1.0", tag]);
    const releases = ["rust-v10.0.0", "rust-v10.1.0"];
    for (const [name, body] of [
      ["rust-v10.2.0", "exit 1"],
      ["rust-v10.3.0", "printf 'p1\\nftxt\\nn/usr/bin/login\\np2\\nftxt\\nnregion info error: Operation not permitted\\n'"],
      ["rust-v10.4.0", "printf 'p1\\nftxt\\nn/usr/bin/login\\n'; exit 1"],
    ]) {
      stub(box.bin, "lsof", body!);
      await box.publish(name!);
      expect((await install(box)).code).toBe(0);
      releases.push(name!);
      expect(readdirSync(join(codexHome(box.home), "releases")).sort()).toEqual([...releases, tag].sort());
    }
  });

  onLinux("removes Fleet's earlier Bun install of Codex only when it shadows the new one", async () => {
    const box = await machine("x86_64", ["x86_64-unknown-linux-musl"]);
    const shim = join(box.home, ".bun/install/global/node_modules/@openai/codex/bin");
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, "codex.js"), "#!/usr/bin/env node\n");
    chmodSync(join(shim, "codex.js"), 0o755);
    mkdirSync(join(box.home, ".bun/bin"), { recursive: true });
    symlinkSync("../install/global/node_modules/@openai/codex/bin/codex.js", join(box.home, ".bun/bin/codex"));
    expect((await install(box)).code).toBe(0);
    expect(box.calls()).not.toContain("bun remove");
    expect((await install(box, `${box.bin}:${box.home}/.bun/bin:${box.home}/.local/bin:/usr/bin:/bin`)).code).toBe(0);
    expect(box.calls()).toContain("bun remove -g @openai/codex");
    expect(existsSync(join(box.home, ".bun/bin/codex"))).toBe(false);
    expect(existsSync(shim)).toBe(false);
    expect(lstatSync(join(box.home, ".local/bin/codex")).isSymbolicLink()).toBe(true);
  });
});
