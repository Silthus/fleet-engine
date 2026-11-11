import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plan, SettingValue } from "../../pack/types.ts";
import { apply, check } from "../../reconciler/apply.ts";
import { gitEnv, spawnGit, tempDirs } from "../../testing/git.ts";
import type { CommandRunner } from "../run.ts";
import { identityAdapter } from "./adapter.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const engine = "/opt/fleet-engine";
const host = "box-1";
const sshKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFEBAkafQlJhgTAbfcFJSHo8kG3VE2c+zMsNYQLmYkjM";
const coderKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICoderCoderCoderCoderCoderCoderCoderCoderCo";

function plan(os: "darwin" | "linux", settings: Record<string, SettingValue> = {}): Plan {
  return {
    machine: { schema: 1, role: os === "darwin" ? "mac" : "devbox" },
    os,
    ai: "both",
    packs: [{ name: "base", source: "engine", ref: "main", available: true }],
    workflows: [],
    files: [],
    config: [],
    owners: {},
    jobs: [],
    human: [],
    steps: [],
    checks: [],
    commands: {},
    handlers: {},
    settings,
    unanswered: [],
    ask: [],
    dropped: [],
    models: [],
  };
}

type Account = { user?: { login: string; id: number; name: string | null; email: string | null }; emails?: Array<{ email: string; primary: boolean; verified: boolean; visibility: string | null }>; scopes?: boolean; otherKeys?: string[]; agent?: string[] };

function github(home: string, account: Account) {
  const keys = { authentication: [] as string[], signing: [] as string[] };
  const calls: string[][] = [];
  const run: CommandRunner = async (command) => {
    calls.push(command);
    const [tool, verb, path] = command;
    if (tool === "gh" && verb === "api") {
      if (path === "user") return account.user ? { code: 0, stdout: JSON.stringify(account.user) } : { code: 1, stdout: "", stderr: "gh: not logged in" };
      if (path === "user/emails") return account.emails ? { code: 0, stdout: JSON.stringify(account.emails) } : { code: 1, stdout: "", stderr: "HTTP 404" };
      const list = { "user/keys": keys.authentication, "user/ssh_signing_keys": keys.signing }[command.at(-1)!];
      if (list && command.includes("--paginate") && command.join(" ").includes("--jq .[].key")) return { code: 0, stdout: [...(account.otherKeys ?? []), ...list].map((key) => `${key}\n`).join("") };
    }
    if (tool === "gh" && verb === "ssh-key" && command[2] === "add") {
      if (account.scopes === false) return { code: 1, stdout: "", stderr: "HTTP 404: needs the admin:ssh_signing_key scope" };
      const type = command[command.indexOf("--type") + 1] as "authentication" | "signing";
      keys[type].push(readFileSync(command[3]!, "utf8").trim().split(" ").slice(0, 2).join(" "));
      return { code: 0, stdout: "" };
    }
    if (tool === "ssh-add" && verb === "-L") return account.agent?.length ? { code: 0, stdout: account.agent.map((key) => `${key} agent\n`).join("") } : { code: 1, stdout: "The agent has no identities.\n" };
    if (tool === "ssh-keygen" && command.includes("-y")) {
      const file = command[command.indexOf("-f") + 1]!;
      return existsSync(file) && readFileSync(file, "utf8") === "PRIVATE\n" ? { code: 0, stdout: `${sshKey} fleet\n` } : { code: 255, stdout: "", stderr: `Load key "${file}": invalid format` };
    }
    if (tool === "ssh-keygen") {
      const file = command[command.indexOf("-f") + 1]!;
      writeFileSync(file, "PRIVATE\n");
      writeFileSync(`${file}.pub`, `${sshKey} fleet\n`);
      return { code: 0, stdout: "" };
    }
    if (tool === "/bin/sh" && verb === `${engine}/scripts/coder-git-key.sh` && path === "public") return { code: 0, stdout: `${coderKey}\n` };
    return { code: 127, stdout: "" };
  };
  return { keys, calls, adapter: identityAdapter({ run, engineRoot: engine, hostname: host }) };
}

const octo: Account = {
  user: { login: "octo", id: 42, name: "Octo Cat", email: null },
  emails: [
    { email: "octo@example.com", primary: true, verified: true, visibility: "public" },
    { email: "old@example.com", primary: false, verified: true, visibility: null },
  ],
};

const read = (home: string, target: string) => readFileSync(join(home, target), "utf8");

describe("the ssh signer", () => {
  test("takes name and email from GitHub, makes a key, and registers it for authentication and signing", async () => {
    const home = temp.make("home-");
    const gh = github(home, octo);

    await apply(plan("linux"), { home, adapters: [gh.adapter] });

    expect(read(home, ".config/fleet/gitconfig")).toBe(`[user]
\tname = "Octo Cat"
\temail = "octo@example.com"
\tsigningkey = "${home}/.ssh/fleet_ed25519.pub"
[gpg]
\tformat = ssh
[gpg "ssh"]
\tallowedSignersFile = "${home}/.ssh/fleet-allowed-signers"
\tprogram = "ssh-keygen"
[core]
\tsshCommand = "ssh -i '${home}/.ssh/fleet_ed25519'"
[commit]
\tgpgsign = true
[tag]
\tgpgsign = true
[push]
\tdefault = simple
`);
    expect(read(home, ".ssh/fleet-allowed-signers")).toBe(`octo@example.com ${sshKey}\n`);
    expect(read(home, ".gitconfig")).toBe("[include]\n\tpath = ~/.config/fleet/gitconfig\n");
    expect(gh.calls).toContainEqual(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `fleet ${host}`, "-f", `${home}/.ssh/fleet_ed25519`]);
    expect(gh.calls).toContainEqual(["gh", "ssh-key", "add", `${home}/.ssh/fleet_ed25519.pub`, "--type", "authentication", "--title", `Fleet ${host}`]);
    expect(gh.calls).toContainEqual(["gh", "ssh-key", "add", `${home}/.ssh/fleet_ed25519.pub`, "--type", "signing", "--title", `Fleet ${host}`]);
    expect(gh.keys).toEqual({ authentication: [sshKey], signing: [sshKey] });
  });

  test("a rerun changes nothing and registers nothing again", async () => {
    const home = temp.make("home-");
    const gh = github(home, octo);
    await apply(plan("linux"), { home, adapters: [gh.adapter] });
    const before = gh.calls.length;

    const report = await apply(plan("linux"), { home, adapters: [gh.adapter] });

    expect(report.actions).toEqual([]);
    expect(gh.calls.slice(before).filter((call) => call[1] === "ssh-key" || (call[0] === "ssh-keygen" && !call.includes("-y")))).toEqual([]);
    expect((await check(plan("linux"), { home, adapters: [gh.adapter] })).ok).toBe(true);
  });

  test("moves Fleet's include back to the end when a later section follows it", async () => {
    const home = temp.make("home-");
    const gh = github(home, octo);
    await apply(plan("linux"), { home, adapters: [gh.adapter] });
    writeFileSync(join(home, ".gitconfig"), `${read(home, ".gitconfig")}[user]\n\tname = Workspace\n`);

    expect((await check(plan("linux"), { home, adapters: [gh.adapter] })).findings.map((finding) => finding.id)).toEqual(["identity:.gitconfig"]);
    await apply(plan("linux"), { home, adapters: [gh.adapter] });

    expect(read(home, ".gitconfig")).toBe("[user]\n\tname = Workspace\n[include]\n\tpath = ~/.config/fleet/gitconfig\n");
  });

  test("keeps the user's .gitconfig and adds Fleet's include at its end, with a backup", async () => {
    const home = temp.make("home-");
    writeFileSync(join(home, ".gitconfig"), "[alias]\n\tst = status");
    const gh = github(home, octo);

    await apply(plan("linux"), { home, adapters: [gh.adapter] });

    expect(read(home, ".gitconfig")).toBe("[alias]\n\tst = status\n[include]\n\tpath = ~/.config/fleet/gitconfig\n");
    const backups = join(home, ".local/state/fleet/backups");
    expect(readdirSync(backups).map((run) => read(home, `.local/state/fleet/backups/${run}/.gitconfig`))).toEqual(["[alias]\n\tst = status"]);
  });

  test("a bare git push from a branch made off origin/main leaves main alone, even when the user set push.default to upstream", async () => {
    const home = temp.make("home-");
    writeFileSync(join(home, ".gitconfig"), "[push]\n\tdefault = upstream\n");
    const remote = temp.make("remote-");
    const work = temp.make("work-");
    await spawnGit(remote, "init", "--bare", "-b", "main");
    await spawnGit(work, "clone", remote, ".");
    await spawnGit(work, "commit", "--allow-empty", "-m", "first");
    await spawnGit(work, "push", "origin", "main");
    await spawnGit(work, "checkout", "-b", "feature", "origin/main");
    await spawnGit(work, "commit", "--allow-empty", "-m", "feature");
    const main = await spawnGit(remote, "rev-parse", "main");

    await apply(plan("linux"), { home, adapters: [github(home, octo).adapter] });

    const { GIT_CONFIG_GLOBAL: _global, ...env } = gitEnv;
    const push = Bun.spawn(["git", "push"], { cwd: work, env: { ...env, HOME: home }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    expect(await push.exited).not.toBe(0);
    expect(await spawnGit(remote, "rev-parse", "main")).toBe(main);
  });

  test("turns on no signing when the private key is missing or does not match", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh/fleet_ed25519.pub"), `${sshKey} fleet\n`);
    const gh = github(home, octo);

    const missing = await check(plan("linux"), { home, adapters: [gh.adapter] });
    writeFileSync(join(home, ".ssh/fleet_ed25519"), "SOMEONE ELSE\n");
    const mismatched = await apply(plan("linux"), { home, adapters: [gh.adapter] });

    const say = "~/.ssh/fleet_ed25519 cannot sign for ~/.ssh/fleet_ed25519.pub: the private key is missing, locked and not in your SSH agent, or belongs to another key. Move both files away, then run fleet apply to make a new Fleet key.";
    expect(missing.findings).toContainEqual({ id: "identity:key", pack: "engine", say, repair: "human" });
    expect(mismatched.findings).toContainEqual({ id: "identity:key", pack: "engine", say, repair: "human" });
    expect(existsSync(join(home, ".config/fleet/gitconfig"))).toBe(false);
  });

  test("signs with a passphrase-protected key that the SSH agent holds", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh/fleet_ed25519"), "ENCRYPTED\n");
    writeFileSync(join(home, ".ssh/fleet_ed25519.pub"), `${sshKey} fleet\n`);
    const locked = await check(plan("linux"), { home, adapters: [github(home, { ...octo, agent: [coderKey] }).adapter] });
    expect(locked.findings.map((item) => item.id)).toContain("identity:key");

    const gh = github(home, { ...octo, agent: [coderKey, sshKey] });
    const report = await apply(plan("linux"), { home, adapters: [gh.adapter] });
    expect(report.findings.map((item) => item.id)).not.toContain("identity:key");
    expect(readFileSync(join(home, ".config/fleet/gitconfig"), "utf8")).toContain("gpgsign = true");
    expect(gh.keys.signing).toEqual([sshKey]);
  });

  test("finds Fleet's key on a later page of the GitHub key lists", async () => {
    const home = temp.make("home-");
    const others = Array.from({ length: 40 }, (_, index) => `ssh-ed25519 AAAA${String(index).padStart(4, "0")}`);
    const gh = github(home, { ...octo, otherKeys: others });
    await apply(plan("linux"), { home, adapters: [gh.adapter] });
    expect((await check(plan("linux"), { home, adapters: [gh.adapter] })).ok).toBe(true);
    expect(gh.calls.filter((call) => call[1] === "api" && call.at(-1) === "user/keys")).toContainEqual(["gh", "api", "--paginate", "--jq", ".[].key", "user/keys"]);
  });

  test("moves only Fleet's path and keeps another include in the same section", async () => {
    const home = temp.make("home-");
    writeFileSync(join(home, ".gitconfig"), "[alias]\n\tst = status\n[include]\n\tpath = ~/.config/fleet/gitconfig\n\tpath = ~/.gitconfig.local\n[user]\n\tname = Workspace\n");
    await apply(plan("linux"), { home, adapters: [github(home, octo).adapter] });
    expect(read(home, ".gitconfig")).toBe("[alias]\n\tst = status\n[include]\n\tpath = ~/.gitconfig.local\n[user]\n\tname = Workspace\n[include]\n\tpath = ~/.config/fleet/gitconfig\n");
  });

  test("leaves the identity alone with a step when ~/.ssh is a link", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    symlinkSync(dotfiles, join(home, ".ssh"));
    const gh = github(home, octo);
    const say = `Left your Git identity alone: ${join(home, ".ssh")} is a link. Fleet writes keys and Git settings only through plain folders.`;
    for (const report of [await check(plan("linux"), { home, adapters: [gh.adapter] }), await apply(plan("linux"), { home, adapters: [gh.adapter] })]) {
      expect(report.findings).toContainEqual({ id: "identity:link", pack: "engine", say, repair: "human" });
    }
    expect(readdirSync(dotfiles)).toEqual([]);
    expect(gh.calls.filter((call) => call[1] === "ssh-key" || (call[0] === "ssh-keygen" && !call.includes("-y")))).toEqual([]);
  });

  test("doctor lists what is missing without writing or registering", async () => {
    const home = temp.make("home-");
    const gh = github(home, octo);

    const report = await check(plan("linux"), { home, adapters: [gh.adapter] });

    expect(report.findings.map((finding) => finding.id).sort()).toEqual(["identity:.config/fleet/gitconfig", "identity:.gitconfig", "identity:.ssh/fleet-allowed-signers", "identity:authentication", "identity:key", "identity:signing"]);
    expect(existsSync(join(home, ".ssh"))).toBe(false);
    expect(gh.calls.filter((call) => call[1] === "ssh-key" || call[0] === "ssh-keygen")).toEqual([]);
  });

  test("reports a missing gh scope and keeps the files it could write", async () => {
    const home = temp.make("home-");
    const gh = github(home, { ...octo, scopes: false });

    const report = await apply(plan("linux"), { home, adapters: [gh.adapter] });

    expect(report.findings).toContainEqual({ id: "identity:signing", pack: "engine", say: "Could not register your Fleet key on GitHub for signing (HTTP 404: needs the admin:ssh_signing_key scope). Run gh auth refresh -h github.com -s admin:public_key,admin:ssh_signing_key, then fleet apply.", repair: "human" });
    expect(existsSync(join(home, ".config/fleet/gitconfig"))).toBe(true);
  });
});

describe("the email", () => {
  test("is the GitHub noreply address when the primary email is private", async () => {
    const home = temp.make("home-");
    const gh = github(home, { ...octo, emails: [{ email: "octo@example.com", primary: true, verified: true, visibility: "private" }] });
    await apply(plan("linux"), { home, adapters: [gh.adapter] });
    expect(read(home, ".config/fleet/gitconfig")).toContain('email = "42+octo@users.noreply.github.com"');
  });

  test("is the noreply address when the primary email has no visibility", async () => {
    const home = temp.make("home-");
    await apply(plan("linux"), { home, adapters: [github(home, { ...octo, emails: [{ email: "octo@example.com", primary: true, verified: true, visibility: null }] }).adapter] });
    expect(read(home, ".config/fleet/gitconfig")).toContain('email = "42+octo@users.noreply.github.com"');
  });

  test("falls back to the public email, then to noreply, when the email list is closed", async () => {
    const home = temp.make("home-");
    await apply(plan("linux"), { home, adapters: [github(home, { user: { login: "octo", id: 42, name: null, email: "public@example.com" } }).adapter] });
    expect(read(home, ".config/fleet/gitconfig")).toContain('name = "octo"\n\temail = "public@example.com"');

    const other = temp.make("home-");
    await apply(plan("linux"), { home: other, adapters: [github(other, { user: { login: "octo", id: 42, name: "Octo", email: null } }).adapter] });
    expect(read(other, ".config/fleet/gitconfig")).toContain('email = "42+octo@users.noreply.github.com"');
  });

  test("escapes quotes and backslashes in a name", async () => {
    const home = temp.make("home-");
    await apply(plan("linux"), { home, adapters: [github(home, { ...octo, user: { ...octo.user!, name: 'O"Cat\\' } }).adapter] });
    expect(read(home, ".config/fleet/gitconfig")).toContain('name = "O\\"Cat\\\\"');
  });

  test("treats an unreadable GitHub answer as a missing sign-in", async () => {
    const home = temp.make("home-");
    const adapter = identityAdapter({ run: async () => ({ code: 0, stdout: "" }), engineRoot: engine, hostname: host });
    const report = await apply(plan("linux"), { home, adapters: [adapter] });
    expect(report.findings).toContainEqual({ id: "identity:github", pack: "engine", say: "Your Git identity waits for the GitHub sign-in (GitHub answered with something Fleet cannot read). Run gh auth login, then fleet apply.", repair: "human" });
  });

  test("waits for the GitHub sign-in and writes nothing", async () => {
    const home = temp.make("home-");
    const report = await apply(plan("linux"), { home, adapters: [github(home, {}).adapter] });
    expect(report.findings).toContainEqual({ id: "identity:github", pack: "engine", say: "Your Git identity waits for the GitHub sign-in (gh: not logged in). Run gh auth login, then fleet apply.", repair: "human" });
    expect(readdirSync(home)).toEqual([".local"]);
  });
});

describe("the coder signer", () => {
  test("signs with the Coder Git key through the engine script and registers it for signing only", async () => {
    const home = temp.make("home-");
    const gh = github(home, octo);

    await apply(plan("linux", { "identity.signer": "coder" }), { home, adapters: [gh.adapter] });

    const script = `${engine}/scripts/coder-git-key.sh`;
    const config = read(home, ".config/fleet/gitconfig");
    expect(config).toContain(`\tsigningkey = "${home}/.ssh/fleet-coder-git.pub"\n`);
    expect(config).toContain(`[gpg "ssh"]\n\tallowedSignersFile = "${home}/.ssh/fleet-allowed-signers"\n\tprogram = "${script}"\n`);
    expect(config).toContain(`\tsshCommand = "'${script}' ssh"\n`);
    expect(read(home, ".ssh/fleet-coder-git.pub")).toBe(`${coderKey}\n`);
    expect(gh.keys).toEqual({ authentication: [], signing: [coderKey] });
    expect(gh.calls.some((call) => call[0] === "ssh-keygen")).toBe(false);
  });
});

describe("the 1Password signer", () => {
  test("asks for the public key of the 1Password SSH key", async () => {
    const home = temp.make("home-");
    const report = await apply(plan("darwin", { "identity.signer": "1password" }), { home, adapters: [github(home, octo).adapter] });
    expect(report.findings).toContainEqual({ id: "identity:key", pack: "engine", say: "Save the public key of your 1Password SSH key to ~/.config/fleet/signing-key.pub, then run fleet apply.", repair: "human" });
    expect(existsSync(join(home, ".config/fleet/gitconfig"))).toBe(false);
  });

  test("signs through op-ssh-sign with the saved public key", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/signing-key.pub"), `${sshKey} my 1password key\n`);
    const gh = github(home, octo);

    await apply(plan("darwin", { "identity.signer": "1password" }), { home, adapters: [gh.adapter] });

    const config = read(home, ".config/fleet/gitconfig");
    expect(config).toContain(`\tsigningkey = "${home}/.config/fleet/signing-key.pub"\n`);
    expect(config).toContain('\tprogram = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign"\n');
    expect(config).not.toContain("sshCommand");
    expect(gh.keys).toEqual({ authentication: [sshKey], signing: [sshKey] });
  });

  test("rejects a private key in place of the public key", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/signing-key.pub"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const report = await apply(plan("darwin", { "identity.signer": "1password" }), { home, adapters: [github(home, octo).adapter] });
    expect(report.findings).toContainEqual({ id: "identity:key", pack: "engine", say: "~/.config/fleet/signing-key.pub must hold one SSH public key. Fleet never reads private keys.", repair: "human" });
  });
});

describe("guards", () => {
  test("an unknown signer is a finding", async () => {
    const home = temp.make("home-");
    const report = await apply(plan("linux", { "identity.signer": "gpg" }), { home, adapters: [github(home, octo).adapter] });
    expect(report.findings).toContainEqual({ id: "identity:signer", pack: "engine", say: "identity.signer is gpg. Use ssh, coder, or 1password.", repair: "human" });
  });

  test("leaves the GitHub account alone when HOME is not the user's home and no runner is given", async () => {
    const home = temp.make("home-");
    const report = await apply(plan("linux"), { home, adapters: [identityAdapter({ engineRoot: engine })] });
    expect(report).toMatchObject({ actions: [], findings: [] });
    expect(readdirSync(home)).toEqual([]);
  });

  test("no name or email is written into the engine", async () => {
    const root = resolve(import.meta.dir, "../../..");
    const tracked = Bun.spawnSync(["git", "ls-files", "src", "scripts", "packs", "fleet", "get.sh"], { cwd: root }).stdout.toString().trim().split("\n");
    const sources = tracked.filter((file) => file && !/\.test\.ts$/.test(file) && !file.startsWith("src/testing/") && existsSync(join(root, file)));
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
    const gitName = /^\s*(name|email)\s*=\s*[^"\s$]/m;
    const hits = sources.filter((file) => {
      const text = readFileSync(join(root, file), "utf8");
      return email.test(text) || gitName.test(text);
    });
    expect(sources.length).toBeGreaterThan(10);
    expect(hits).toEqual([]);
  });
});
