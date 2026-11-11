import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const onLinux = test.skipIf(process.platform !== "linux");
const shipped = readFileSync(join(import.meta.dir, "node.release"), "utf8");
const version = shipped.match(/^version (\S+)$/m)![1]!;
const targets = ["linux-x64", "linux-arm64"];

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${join(bin, "calls.log")}"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

async function archive(dist: string, target: string) {
  const tree = temp.make("node-tree-");
  const top = join(tree, `node-v${version}-${target}`, "bin");
  mkdirSync(top, { recursive: true });
  for (const name of ["node", "npm", "npx"]) {
    writeFileSync(join(top, name), `#!/bin/sh\necho "${name} ${version} ${target}"\n`);
    chmodSync(join(top, name), 0o755);
  }
  const file = join(dist, `node-v${version}-${target}.tar.gz`);
  expect(await Bun.spawn(["tar", "-czf", file, "-C", tree, `node-v${version}-${target}`]).exited).toBe(0);
  return new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
}

async function machine(arch: string, options: { corrupt?: boolean } = {}) {
  const bin = temp.make("bin-");
  const home = temp.make("home-");
  const dist = temp.make("dist-");
  const lib = temp.make("lib-");
  const sums = await Promise.all(targets.map((target) => archive(dist, target)));
  copyFileSync(join(import.meta.dir, "install-node.sh"), join(lib, "install-node.sh"));
  writeFileSync(join(lib, "node.release"), [`version ${version}`, ...targets.map((target, index) => `${target} ${options.corrupt ? "0".repeat(64) : sums[index]}`)].join("\n") + "\n");
  stub(bin, "uname", `echo ${arch}`);
  stub(
    bin,
    "curl",
    [
      "out='' url=''",
      'while [ "$#" -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done',
      `case "$url" in https://nodejs.org/dist/v${version}/*) ;; *) exit 22 ;; esac`,
      `file="${dist}/\${url##*/}"`,
      '[ -f "$file" ] || exit 22',
      'cp "$file" "$out"',
    ].join("\n"),
  );
  const calls = () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8") : "");
  const install = async (path = `${bin}:${home}/.local/bin:/usr/bin:/bin`) => {
    const child = Bun.spawn(["/bin/sh", join(lib, "install-node.sh")], { env: { HOME: home, PATH: path }, stdout: "pipe", stderr: "pipe" });
    return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
  };
  return { bin, home, calls, install, downloads: () => calls().split("\n").filter((line) => line.startsWith("curl ")) };
}

async function runs(home: string, name: string) {
  const child = Bun.spawn([join(home, ".local/bin", name), "--version"], { stdout: "pipe" });
  return (await new Response(child.stdout).text()).trim();
}

describe("install-node.sh", () => {
  onLinux.each([
    ["x86_64", "linux-x64"],
    ["aarch64", "linux-arm64"],
  ])("installs the pinned, checked Node.js for %s, so node, npm and npx run from ~/.local/bin", async (arch, target) => {
    const box = await machine(arch);
    expect(await box.install()).toMatchObject({ code: 0 });
    for (const name of ["node", "npm", "npx"]) expect(await runs(box.home, name)).toBe(`${name} ${version} ${target}`);
    expect(readlinkSync(join(box.home, ".local/bin/npx"))).toBe(join(box.home, `.local/share/fleet/node/node-v${version}-${target}/bin/npx`));
    expect(box.downloads()).toEqual([expect.stringContaining(`https://nodejs.org/dist/v${version}/node-v${version}-${target}.tar.gz`)]);
  });

  onLinux("downloads nothing when node and npx already run, so a Node the person installed stays in charge", async () => {
    const box = await machine("x86_64");
    expect((await box.install()).code).toBe(0);
    expect((await box.install()).code).toBe(0);
    expect(box.downloads()).toHaveLength(1);
    const other = temp.make("other-node-");
    for (const name of ["node", "npx"]) stub(other, name, "echo other");
    const fresh = await machine("x86_64");
    expect(await fresh.install(`${fresh.bin}:${other}:/usr/bin:/bin`)).toMatchObject({ code: 0 });
    expect(fresh.downloads()).toEqual([]);
    expect(existsSync(join(fresh.home, ".local/bin/node"))).toBe(false);
  });

  onLinux("refuses an archive whose checksum does not match the pin, and installs nothing", async () => {
    const box = await machine("x86_64", { corrupt: true });
    const result = await box.install();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("checksum");
    expect(existsSync(join(box.home, ".local/bin/node"))).toBe(false);
    expect(existsSync(join(box.home, ".local/share/fleet/node"))).toBe(false);
  });

  onLinux("keeps a node, npm or npx in ~/.local/bin that Fleet did not put there", async () => {
    const box = await machine("x86_64");
    mkdirSync(join(box.home, ".local/bin"), { recursive: true });
    stub(join(box.home, ".local/bin"), "npm", "echo mine");
    expect((await box.install()).code).toBe(0);
    expect(await runs(box.home, "npm")).toBe("mine");
    expect(await runs(box.home, "npx")).toBe(`npx ${version} linux-x64`);
  });

  onLinux("names the machine type when it has no pinned build", async () => {
    const box = await machine("riscv64");
    const result = await box.install();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("riscv64");
    expect(box.downloads()).toEqual([]);
  });
});
