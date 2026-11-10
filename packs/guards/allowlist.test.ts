import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, mac, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { guard } from "./hooks/guards.ts";
import { allowlistCommand, signatureFile } from "./lib/allowlist-command.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const run = (command: string[], env: Record<string, string> = {}) => {
  const result = Bun.spawnSync(command, { env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
};

function newKey() {
  const key = join(temp.make("key-"), "signer");
  expect(run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test signer", "-f", key]).code).toBe(0);
  return { key, publicKey: readFileSync(`${key}.pub`, "utf8") };
}

function machineWith(owners: string, signerKey: string) {
  const home = temp.make("home-");
  const root = temp.make("root-");
  const profileDir = temp.make("profile-");
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
    const list = join(temp.make("sign-"), "list");
    writeFileSync(list, `${fleet("text").output}\n`);
    expect(run(["ssh-keygen", "-q", "-Y", "sign", "-f", key, "-n", "fleet-git-allowlist", list]).code).toBe(0);
    mkdirSync(join(profileDir, "guards"), { recursive: true });
    renameSync(`${list}.sig`, signatureFile(profileDir));
  };
  const staged = join(home, ".local/state/fleet/git-allowlist");
  const install = () => run(["sh", join(staged, "install.sh"), "install", root]);
  const git = (...args: string[]) => run(["git", ...args], { HOME: home, GIT_CONFIG_SYSTEM: join(root, "etc/gitconfig"), GIT_CONFIG_GLOBAL: "/dev/null", PATH: `${join(root, "usr/local/bin")}:${process.env.PATH}` });
  return { home, root, settings, fleet, sign, staged, install, git };
}

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

  test("a signed list installs, Git refuses every other remote, and the refusal names the person", () => {
    const { key, publicKey } = newKey();
    const machine = machineWith("acme, octo-org", publicKey);
    machine.sign(key);
    expect(machine.fleet()).toEqual({ code: 0, output: expect.stringContaining("verified.\nSystem: not installed.") });
    expect(machine.fleet("--check").code).toBe(1);
    expect(machine.fleet("stage", machine.staged).code).toBe(0);
    expect(machine.install()).toMatchObject({ code: 0, stdout: "Git allowlist: on." });
    expect(machine.fleet("--check").code).toBe(0);

    for (const url of ["https://github.com/acme/app", "git@github.com:octo-org/site", "ssh://git@github.com/acme/app"]) {
      expect(machine.git("ls-remote", "--get-url", url).stdout).not.toStartWith("fleet-blocked::");
    }
    for (const url of ["https://github.com/evil/app", "git@github.com:evil/app", "https://github.com/acme-evil/app", "ssh://git@gitlab.example/a/b"]) {
      expect(machine.git("ls-remote", "--get-url", url).stdout).toBe(`fleet-blocked::${url}`);
    }
    const blocked = machine.git("ls-remote", "https://x-access-token:secret-value@github.com/evil/app");
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("not on the signed Git allowlist. Stop and ask Robin.");
    expect(blocked.stderr).not.toContain("secret-value");
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

  test("the root step refuses a list that another key signed once signers are pinned, and changes nothing", () => {
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
    expect(machine.git("ls-remote", "--get-url", "https://github.com/evil/app").stdout).toBe("fleet-blocked::https://github.com/evil/app");
  });

  test("the root step turns the list off again", () => {
    const { key, publicKey } = newKey();
    const machine = machineWith("acme", publicKey);
    machine.sign(key);
    machine.fleet("stage", machine.staged);
    machine.install();
    expect(run(["sh", join(machine.staged, "install.sh"), "remove", machine.root])).toMatchObject({ code: 0, stdout: "Git allowlist: off." });
    expect(machine.git("ls-remote", "--get-url", "https://github.com/evil/app").stdout).toBe("https://github.com/evil/app");
    expect(machine.fleet("--check").code).toBe(1);
  });
});
