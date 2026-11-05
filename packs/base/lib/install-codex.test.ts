import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const onLinux = test.skipIf(process.platform !== "linux");
const script = join(import.meta.dir, "install-codex.sh");
const tag = "rust-v9.9.9";

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${join(bin, "calls.log")}"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

async function release(targets: string[], corrupt = false) {
  const dir = temp.make("release-");
  const sums: string[] = [];
  for (const target of targets) {
    const tree = temp.make("package-");
    mkdirSync(join(tree, "bin"));
    writeFileSync(join(tree, "bin", "codex"), `#!/bin/sh\necho "codex-cli 9.9.9 ${target}"\n`);
    chmodSync(join(tree, "bin", "codex"), 0o755);
    const asset = `codex-package-${target}.tar.gz`;
    expect(await Bun.spawn(["tar", "-czf", join(dir, asset), "-C", tree, "bin"]).exited).toBe(0);
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, asset))).digest("hex");
    sums.push(`${corrupt ? "0".repeat(64) : digest}  ${asset}`);
  }
  writeFileSync(join(dir, "codex-package_SHA256SUMS"), `${sums.join("\n")}\n`);
  return dir;
}

function machine(arch: string, releaseDir: string) {
  const bin = temp.make("bin-");
  const home = temp.make("home-");
  stub(bin, "uname", `echo ${arch}`);
  stub(
    bin,
    "curl",
    [
      "out='' url='' effective=''",
      'while [ "$#" -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -w) effective=1; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done',
      `[ -z "$effective" ] || { printf '%s' "https://github.com/openai/codex/releases/tag/${tag}"; exit 0; }`,
      `case "$url" in https://github.com/openai/codex/releases/download/${tag}/*) ;; *) exit 22 ;; esac`,
      `file="${releaseDir}/\${url##*/}"`,
      '[ -f "$file" ] || exit 22',
      'cp "$file" "$out"',
    ].join("\n"),
  );
  stub(bin, "bun", "exit 0");
  return { bin, home, calls: () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8") : "") };
}

async function install(box: { bin: string; home: string }, path = `${box.bin}:${box.home}/.local/bin:/usr/bin:/bin`) {
  const child = Bun.spawn(["sh", script], { env: { HOME: box.home, PATH: path }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

async function version(home: string) {
  const child = Bun.spawn([join(home, ".local/bin/codex"), "--version"], { stdout: "pipe" });
  return (await new Response(child.stdout).text()).trim();
}

describe("install-codex.sh", () => {
  onLinux.each([
    ["x86_64", "x86_64-unknown-linux-musl"],
    ["aarch64", "aarch64-unknown-linux-musl"],
  ])("installs the checked release package for %s into ~/.local/bin", async (arch, target) => {
    const box = machine(arch, await release(["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"]));
    expect(await install(box)).toMatchObject({ code: 0 });
    expect(await version(box.home)).toBe(`codex-cli 9.9.9 ${target}`);
    expect(readlinkSync(join(box.home, ".local/bin/codex"))).toBe(join(box.home, ".local/share/fleet/codex/bin/codex"));
    expect(box.calls()).toContain(`/releases/download/${tag}/codex-package-${target}.tar.gz`);
    expect(box.calls()).not.toContain("bun ");
  });

  onLinux("installs again over its own earlier install", async () => {
    const box = machine("x86_64", await release(["x86_64-unknown-linux-musl"]));
    expect((await install(box)).code).toBe(0);
    expect((await install(box)).code).toBe(0);
    expect(await version(box.home)).toBe("codex-cli 9.9.9 x86_64-unknown-linux-musl");
  });

  onLinux("refuses a machine with no Codex build, before it downloads anything", async () => {
    const box = machine("riscv64", await release(["x86_64-unknown-linux-musl"]));
    const result = await install(box);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no Codex build for riscv64");
    expect(box.calls()).not.toContain("curl");
  });

  onLinux("refuses a download that does not match its checksum", async () => {
    const box = machine("aarch64", await release(["aarch64-unknown-linux-musl"], true));
    const result = await install(box);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("does not match its checksum");
    expect(existsSync(join(box.home, ".local/bin/codex"))).toBe(false);
  });

  onLinux("keeps a codex in ~/.local/bin that Fleet did not install", async () => {
    const box = machine("x86_64", await release(["x86_64-unknown-linux-musl"]));
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    writeFileSync(join(box.home, ".local/bin/codex"), "mine\n");
    const result = await install(box);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Fleet did not install it");
    expect(readFileSync(join(box.home, ".local/bin/codex"), "utf8")).toBe("mine\n");
  });

  onLinux("removes Fleet's earlier Bun install of Codex only when it shadows the new one", async () => {
    const box = machine("x86_64", await release(["x86_64-unknown-linux-musl"]));
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
