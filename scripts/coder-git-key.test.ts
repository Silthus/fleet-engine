import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "coder-git-key.sh");
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fakeTools(): { bin: string; runtime: string } {
  const bin = mkdtempSync(join(tmpdir(), "fleet-coder-key-bin-"));
  const runtime = mkdtempSync(join(tmpdir(), "fleet-coder-key-run-"));
  directories.push(bin, runtime);
  const tools: Record<string, string> = {
    curl: `case "$*" in
  *aws-instance-identity*) cat >/dev/null; echo '{"session_token":"agent-session"}' ;;
  *gitsshkey*) echo '{"public_key":"ssh-ed25519 PUBLIC","private_key":"PRIVATE KEY"}' ;;
  *) echo metadata ;;
esac`,
    "ssh-keygen": `echo "$*" > "$FAKE_LOG"; while [ $# -gt 0 ]; do [ "$1" = -f ] && cat "$2" >> "$FAKE_LOG"; shift; done`,
    ssh: `echo "$*" > "$FAKE_LOG"; [ "$3" = -i ] && cat "$4" >> "$FAKE_LOG"; exit 3`,
  };
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, runtime };
}

function run(args: string[]) {
  const { bin, runtime } = fakeTools();
  const log = join(runtime, "log");
  const child = Bun.spawnSync(["sh", script, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: runtime, FAKE_LOG: log },
  });
  const leftovers = readdirSync(runtime).filter((name) => name.startsWith("fleet-coder-git."));
  return { code: child.exitCode, log: existsSync(log) ? readFileSync(log, "utf8") : "", leftovers };
}

test("signing passes the fetched private key to ssh-keygen and leaves no key file behind", () => {
  const signed = run(["-Y", "sign", "-n", "git", "-f", "/home/user/.ssh/fleet-coder-git.pub", "-U", "/tmp/buffer"]);
  expect(signed.code).toBe(0);
  expect(signed.log).toMatch(/^-Y sign -n git -f \S+fleet-coder-git\.\S+ \/tmp\/buffer\nPRIVATE KEY\n$/);
  expect(signed.leftovers).toEqual([]);
});

test("ssh to GitHub keeps its exit code and leaves no key file behind", () => {
  const ssh = run(["ssh", "git@github.com", "git-upload-pack 'owner/repo.git'"]);
  expect(ssh.code).toBe(3);
  expect(ssh.log).toContain("PRIVATE KEY");
  expect(ssh.leftovers).toEqual([]);
});

test("ssh to another host runs without the Coder key", () => {
  const ssh = run(["ssh", "git@gitlab.com", "git-upload-pack 'group/repo.git'"]);
  expect(ssh.code).toBe(3);
  expect(ssh.log).toBe("git@gitlab.com git-upload-pack 'group/repo.git'\n");
});

test("runs without a session environment, as in the detached T3 service", () => {
  const { bin, runtime } = fakeTools();
  const child = Bun.spawnSync(["/bin/sh", script, "public"], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: runtime } });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("ssh-ed25519 PUBLIC\n");
});
