import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, mac, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { guard } from "./hooks/guards.ts";
import { allowlistCommand, signatureFile } from "./lib/allowlist-command.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const proxied: string[] = [];
const proxy = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data(socket, data) {
      proxied.push(data.toString().split("\r\n")[0]);
      socket.end();
    },
  },
});
afterAll(() => proxy.stop(true));

const run = (command: string[], env: Record<string, string> = {}) => {
  const result = Bun.spawnSync(command, { env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
};

type Dirs = ReturnType<typeof tempDirs>;

function newKey(dirs: Dirs = temp) {
  const key = join(dirs.make("key-"), "signer");
  expect(run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test signer", "-f", key]).code).toBe(0);
  return { key, publicKey: readFileSync(`${key}.pub`, "utf8") };
}

function machineWith(owners: string, signerKey: string, dirs: Dirs = temp) {
  const home = dirs.make("home-");
  const root = dirs.make("root-");
  const profileDir = dirs.make("profile-");
  const settings: Record<string, unknown> = { "guards.person": "Robin", "guards.owners": owners, "guards.signers": signerKey };
  mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
  writeFileSync(join(home, ".local/state/fleet/settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  const lines: string[] = [];
  const fleet = (...args: string[]) => {
    lines.length = 0;
    const code = allowlistCommand(args, { settings, profileDir, root, print: (line) => lines.push(line) });
    return { code, output: lines.join("\n") };
  };
  const sign = (key: string) => {
    const list = join(dirs.make("sign-"), "list");
    writeFileSync(list, `${fleet("text").output}\n`);
    expect(run(["ssh-keygen", "-q", "-Y", "sign", "-f", key, "-n", "fleet-git-allowlist", list]).code).toBe(0);
    mkdirSync(join(profileDir, "guards"), { recursive: true });
    renameSync(`${list}.sig`, signatureFile(profileDir));
  };
  const staged = join(home, ".local/state/fleet/git-allowlist");
  const install = () => run(["sh", join(staged, "install.sh"), "install", root]);
  const sshLog = join(home, "ssh.log");
  const ssh = join(home, "bin/ssh");
  mkdirSync(dirname(ssh));
  writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${sshLog}\nexit 1\n`, { mode: 0o755 });
  const lsRemote = async (url: string) => {
    rmSync(sshLog, { force: true });
    proxied.length = 0;
    const child = Bun.spawn(["git", "ls-remote", url], {
      env: {
        HOME: home,
        PATH: `${join(root, "usr/local/bin")}:${process.env.PATH}`,
        GIT_CONFIG_SYSTEM: join(root, "etc/gitconfig"),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: ssh,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.proxy",
        GIT_CONFIG_VALUE_0: `http://127.0.0.1:${proxy.port}`,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    const network = [...proxied, ...(existsSync(sshLog) ? readFileSync(sshLog, "utf8").trim().split("\n") : [])];
    return { code, stderr, network };
  };
  const refusedByFleet = async (url: string) => {
    const { code, stderr, network } = await lsRemote(url);
    return { refused: code !== 0 && stderr.includes("not on the signed Git allowlist. Stop and ask Robin."), network };
  };
  return { home, root, settings, fleet, sign, staged, install, lsRemote, refusedByFleet };
}

function installed(owners: string, dirs: Dirs = temp) {
  const { key, publicKey } = newKey(dirs);
  const machine = machineWith(owners, publicKey, dirs);
  machine.sign(key);
  machine.fleet("stage", machine.staged);
  expect(machine.install().code).toBe(0);
  return machine;
}

const contents = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
    const path = join(entry.parentPath, entry.name);
    return [path, entry.isFile() ? readFileSync(path, "utf8") : entry.isDirectory() ? "folder" : "link"];
  });

describe("the signed Git allowlist workflow", () => {
  const plan = (workflows: Record<string, boolean>, machine = devbox) =>
    resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["guards"], workflows, settings: { "guards.owners": "acme", "guards.signers": "ssh-ed25519 AAAA test" } }, machine);

  test("asks a person to install the list as root on a Linux devbox, and probes it with fleet guards allowlist", () => {
    expect(plan({}).human).toEqual([]);
    const step = plan({ "git-allowlist": true }).human.find((item) => item.id === "git-allowlist");
    expect(step?.command).toContain("sudo sh ~/.local/state/fleet/git-allowlist/install.sh");
    expect(step?.probe).toEqual(["fleet", "guards", "allowlist", "--check"]);
    expect(plan({ "git-allowlist": true }, mac).human).toEqual([]);
  });

  test("keeps guards.owners for the gh guard when only the shell guards are on", () => {
    expect(plan({ "shell-guards": true }).settings["guards.owners"]).toBe("acme");
    expect(plan({ "shell-guards": true }).settings["guards.signers"]).toBeUndefined();
  });
});

describe("Git on a machine with the signed list installed", () => {
  const kept = tempDirs();
  let machine: ReturnType<typeof machineWith>;
  beforeAll(() => (machine = installed("acme, octo-org", kept)));
  afterAll(() => kept.cleanup());

  test("Git still reaches every listed owner over HTTPS and SSH", async () => {
    const reached: Record<string, unknown> = {};
    const connect = ["CONNECT github.com:443 HTTP/1.1"];
    const expected = {
      "https://github.com/acme/app": { refused: false, network: connect },
      "https::https://github.com/acme/app": { refused: false, network: connect },
      "git://github.com/octo-org/site": { refused: false, network: connect },
      "git@github.com:octo-org/site": { refused: false, network: ["-o SendEnv=GIT_PROTOCOL git@github.com git-upload-pack 'octo-org/site'"] },
      "ssh://git@github.com/acme/app": { refused: false, network: ["-o SendEnv=GIT_PROTOCOL git@github.com git-upload-pack 'acme/app'"] },
      "github.com:acme/app": { refused: false, network: ["-o SendEnv=GIT_PROTOCOL github.com git-upload-pack 'acme/app'"] },
      "ssh://git@ssh.github.com:443/acme/app": { refused: false, network: ["-o SendEnv=GIT_PROTOCOL -p 443 git@ssh.github.com git-upload-pack '/acme/app'"] },
    };
    for (const url of Object.keys(expected)) reached[url] = await machine.refusedByFleet(url);
    expect(reached).toEqual(expected);
  });

  test("Git refuses every other remote before it touches the network", async () => {
    const urls = [
      "https://github.com/evil/app",
      "https://github.com/acme-evil/app",
      "git@github.com:evil/app",
      "ssh://git@gitlab.example/a/b",
      "github.com:evil/app",
      "ssh.github.com:evil/app",
      "https::https://github.com/evil/app",
      "http::http://github.com/evil/app",
    ];
    const outcomes: Record<string, unknown> = {};
    for (const url of urls) outcomes[url] = await machine.refusedByFleet(url);
    expect(outcomes).toEqual(Object.fromEntries(urls.map((url) => [url, { refused: true, network: [] }])));
  });

  test.each(["https://x-access-token:secret-value@github.com/evil/app", "https::https://x-access-token:secret-value@github.com/evil/app"])("the refusal keeps the credentials of %s out of its text", async (url) => {
    const blocked = await machine.lsRemote(url);
    expect(blocked.stderr).toContain("not on the signed Git allowlist. Stop and ask Robin.");
    expect(blocked.stderr).not.toContain("secret-value");
  });
});

describe("fleet guards allowlist", () => {
  test("prints the exact text to sign and says how to sign it until the profile holds a signature", () => {
    const { publicKey } = newKey();
    const machine = machineWith("acme, octo-org", publicKey);
    expect(machine.fleet("text")).toEqual({ code: 0, output: "acme\nocto-org" });
    const unsigned = machine.fleet();
    expect(unsigned.code).toBe(1);
    expect(unsigned.output).toContain("not verified");
    expect(unsigned.output).toContain("ssh-keygen -Y sign");
    expect(() => machine.fleet("stage", machine.staged)).toThrow("was not staged");
  });

  test("a signed list installs and then passes the doctor probe", () => {
    const { key, publicKey } = newKey();
    const machine = machineWith("acme, octo-org", publicKey);
    machine.sign(key);
    expect(machine.fleet()).toEqual({ code: 0, output: expect.stringContaining("verified.\nSystem: not installed.") });
    expect(machine.fleet("--check").code).toBe(1);
    expect(machine.fleet("stage", machine.staged).code).toBe(0);
    expect(machine.install()).toMatchObject({ code: 0, stdout: "Git allowlist: on." });
    expect(machine.fleet("--check").code).toBe(0);

  });

  test.each([
    ["the installed Git config is emptied", (root: string) => writeFileSync(join(root, "etc/fleet/git-allowlist.gitconfig"), "")],
    ["the installed Git config refuses a listed owner", (root: string) => {
      const config = join(root, "etc/fleet/git-allowlist.gitconfig");
      writeFileSync(config, readFileSync(config, "utf8").split("\n").filter((line) => !line.includes("github.com/acme/")).join("\n"));
    }],
    ["the blocked-remote helper is not executable", (root: string) => chmodSync(join(root, "usr/local/bin/git-remote-fleet-blocked"), 0o644)],
    ["the pinned signers hold another key", (root: string) => writeFileSync(join(root, "etc/fleet/git-allowlist-signers"), `fleet-allowlist namespaces="fleet-git-allowlist" ${newKey().publicKey}`)],
  ])("the doctor probe fails when %s", (_, breakInstall) => {
    const machine = installed("acme");
    expect(machine.fleet("--check").code).toBe(0);
    breakInstall(machine.root);
    expect(machine.fleet("--check").code).toBe(1);
    expect(machine.fleet().output).not.toContain("System: installed.");
  });

  test.each(["etc/fleet", "etc/fleet/git-allowlist-signers", "etc/fleet/git-allowlist", "usr/local/bin/git-remote-fleet-blocked", "etc/gitconfig"])("the root step refuses a symbolic link at %s and writes nothing", (target) => {
    const { key, publicKey } = newKey();
    const machine = machineWith("acme", publicKey);
    machine.sign(key);
    machine.fleet("stage", machine.staged);
    const elsewhere = temp.make("agent-owned-");
    const pointed = join(elsewhere, "target");
    if (target === "etc/fleet") mkdirSync(pointed);
    else writeFileSync(pointed, "agent-owned\n");
    mkdirSync(dirname(join(machine.root, target)), { recursive: true });
    symlinkSync(pointed, join(machine.root, target));
    const before = contents(elsewhere);

    const refused = machine.install();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`${join(machine.root, target)} is a symbolic link. Nothing changed.`);
    expect(contents(elsewhere)).toEqual(before);
  });

  test("gh keeps the installed list until a person installs a newly signed one", () => {
    const { key, publicKey } = newKey();
    const machine = machineWith("acme", publicKey);
    machine.sign(key);
    machine.fleet("stage", machine.staged);
    expect(machine.install().code).toBe(0);
    const gh = (command: string) => guard({ tool_name: "Bash", tool_input: { command } }, machine.home, machine.root)?.hookSpecificOutput.permissionDecisionReason;

    machine.settings["guards.owners"] = "acme, newcomer";
    writeFileSync(join(machine.home, ".local/state/fleet/settings.json"), JSON.stringify(machine.settings));
    expect(gh("gh pr view -R newcomer/app 1")).toContain("`newcomer` is not one of the GitHub owners");
    expect(machine.fleet("--check").code).toBe(1);

    machine.sign(key);
    expect(machine.fleet("--check").code).toBe(1);
    machine.fleet("stage", machine.staged);
    expect(machine.install().code).toBe(0);
    expect(gh("gh pr view -R newcomer/app 1")).toBeUndefined();
    expect(machine.fleet("--check").code).toBe(0);
  });

  test("the root step refuses a list that another key signed once signers are pinned, and changes nothing", async () => {
    const first = newKey();
    const machine = machineWith("acme", first.publicKey);
    machine.sign(first.key);
    machine.fleet("stage", machine.staged);
    expect(machine.install().code).toBe(0);

    const other = newKey();
    writeFileSync(join(machine.staged, "git-allowlist"), "acme\nevil\n");
    writeFileSync(join(machine.staged, "git-allowlist-signers"), `fleet-allowlist namespaces="fleet-git-allowlist" ${other.publicKey}`);
    rmSync(join(machine.staged, "git-allowlist.sig"));
    expect(run(["ssh-keygen", "-q", "-Y", "sign", "-f", other.key, "-n", "fleet-git-allowlist", join(machine.staged, "git-allowlist")]).code).toBe(0);
    const refused = machine.install();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("does not verify");
    expect(readFileSync(join(machine.root, "etc/fleet/git-allowlist"), "utf8")).toBe("acme\n");
    expect(await machine.refusedByFleet("https://github.com/evil/app")).toEqual({ refused: true, network: [] });
  });

  test("the root step turns the list off again", async () => {
    const machine = installed("acme");
    expect(run(["sh", join(machine.staged, "install.sh"), "remove", machine.root])).toMatchObject({ code: 0, stdout: "Git allowlist: off." });
    expect(await machine.refusedByFleet("https://github.com/evil/app")).toEqual({ refused: false, network: ["CONNECT github.com:443 HTTP/1.1"] });
    expect(machine.fleet("--check").code).toBe(1);
  });
});
