import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "install-gitleaks.sh");
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

function install(os: string, machine: string) {
  const bin = tempDir("fleet-gitleaks-bin-");
  const tools: Record<string, string> = {
    uname: `[ "$1" = -s ] && echo ${os} || echo ${machine}`,
    curl: `while [ $# -gt 0 ]; do [ "$1" = -o ] && echo tampered > "$2"; shift; done`,
  };
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const target = join(tempDir("fleet-gitleaks-target-"), "bin");
  const child = Bun.spawnSync(["sh", script, target], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { code: child.exitCode, error: child.stderr.toString(), installed: existsSync(join(target, "gitleaks")) };
}

test.each([
  ["Linux", "x86_64", "linux_x64"],
  ["Linux", "aarch64", "linux_arm64"],
  ["Darwin", "x86_64", "darwin_x64"],
  ["Darwin", "arm64", "darwin_arm64"],
])("on %s %s it checks the %s build and refuses a download that fails the checksum", (os, machine, platform) => {
  expect(install(os, machine)).toEqual({
    code: 1,
    error: `install-gitleaks: checksum mismatch for gitleaks_8.21.2_${platform}.tar.gz.\n`,
    installed: false,
  });
});

test("refuses a machine without a pinned build", () => {
  expect(install("Linux", "riscv64")).toEqual({
    code: 1,
    error: "install-gitleaks: no pinned gitleaks build for Linux riscv64.\n",
    installed: false,
  });
});
