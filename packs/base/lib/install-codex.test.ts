import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const onLinux = test.skipIf(process.platform !== "linux");
const script = join(import.meta.dir, "install-codex.sh");
const tag = "rust-v9.9.9";
const realMv = Bun.which("mv") ?? "/bin/mv";

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${join(bin, "calls.log")}"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

async function release(root: string, targets: string[], options: { tag?: string; corrupt?: boolean } = {}) {
  const name = options.tag ?? tag;
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const sums: string[] = [];
  for (const target of targets) {
    const tree = temp.make("package-");
    mkdirSync(join(tree, "bin"));
    writeFileSync(join(tree, "bin", "codex"), `#!/bin/sh\necho "codex-cli ${name.replace("rust-v", "")} ${target}"\n`);
    chmodSync(join(tree, "bin", "codex"), 0o755);
    const asset = `codex-package-${target}.tar.gz`;
    expect(await Bun.spawn(["tar", "-czf", join(dir, asset), "-C", tree, "bin"]).exited).toBe(0);
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, asset))).digest("hex");
    sums.push(`${options.corrupt ? "0".repeat(64) : digest}  ${asset}`);
  }
  writeFileSync(join(dir, "codex-package_SHA256SUMS"), `${sums.join("\n")}\n`);
  writeFileSync(join(root, "latest"), name);
}

async function machine(arch: string, targets: string[], options: { corrupt?: boolean } = {}) {
  const bin = temp.make("bin-");
  const home = temp.make("home-");
  const root = temp.make("releases-");
  await release(root, targets, options);
  stub(bin, "uname", `echo ${arch}`);
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
  stub(bin, "bun", "exit 0");
  return {
    bin,
    home,
    publish: (name: string) => release(root, [targets[0] ?? ""], { tag: name }),
    calls: () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8") : ""),
  };
}

async function install(box: { bin: string; home: string }, path = `${box.bin}:${box.home}/.local/bin:/usr/bin:/bin`) {
  const child = Bun.spawn(["sh", script], { env: { HOME: box.home, PATH: path }, stdout: "pipe", stderr: "pipe" });
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
    ["the move of the new release", "exit 1"],
    ["the switch to the new release", `case " $* " in *" -T "*) exit 1 ;; esac; exec ${realMv} "$@"`],
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
    expect(readdirSync(join(box.home, ".local/share/fleet"))).toEqual([]);
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
    expect(lstatSync(join(box.home, ".local/bin/codex")).isSymbolicLink()).toBe(true);
  });
});
