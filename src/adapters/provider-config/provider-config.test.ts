import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { ConfigEntry, Plan } from "../../pack/types.ts";
import { apply, check, filesAdapter } from "../../reconciler/apply.ts";
import { tempDirs } from "../../testing/git.ts";
import { providerConfigAdapter, type CommandRunner } from "./adapter.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const claude = ".claude/settings.json";
const codex = ".codex/config.toml";
const record = ".config/fleet/provider-fields.json";

function plan(config: Array<ConfigEntry & { pack?: string }> = []): Plan {
  return {
    machine: { schema: 1, role: "mac" },
    os: "darwin",
    ai: "both",
    packs: [{ name: "base", source: "engine", ref: "main", available: true }],
    workflows: [],
    files: [],
    config: config.map((entry) => ({ pack: "base", ...entry })),
    owners: {},
    jobs: [],
    human: [],
    steps: [],
    checks: [],
    commands: {},
    settings: {},
    unanswered: [],
    dropped: [],
  };
}

function write(home: string, target: string, content: unknown) {
  mkdirSync(dirname(join(home, target)), { recursive: true });
  writeFileSync(join(home, target), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

const read = (home: string, target: string) => JSON.parse(readFileSync(join(home, target), "utf8"));
const backups = (home: string) => {
  const root = join(home, ".local/state/fleet/backups");
  return existsSync(root) ? readdirSync(root).map((run) => join(root, run)) : [];
};

function claudeCli(installed: string[] = []) {
  const calls: string[][] = [];
  const run: CommandRunner = async (command) => {
    calls.push(command);
    if (command.join(" ") === "claude plugin list --json") return { code: 0, stdout: JSON.stringify(installed.map((id) => ({ id, scope: "user", version: "1.0.0", enabled: true }))) };
    if (command[2] === "install") installed.push(command[3]!);
    if (command[2] === "uninstall") installed.splice(installed.indexOf(command[3]!), 1);
    return { code: 0, stdout: "" };
  };
  return { calls, run, adapter: providerConfigAdapter({ run }) };
}

const adapters = (run = claudeCli().run) => [filesAdapter, providerConfigAdapter({ run })];

describe("provider config", () => {
  test("removes a stale proxy base URL with a backup, and keeps every key Fleet never wrote", async () => {
    const home = temp.make("home-");
    const before = { model: "opus", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: "proxy-key", MY_FLAG: "1" }, permissions: { allow: ["Bash(ls)"] } };
    write(home, claude, before);

    const report = await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ model: "opus", env: { MY_FLAG: "1" }, permissions: { allow: ["Bash(ls)"] } });
    expect(report.actions).toContainEqual({ target: claude, operation: "replace", reason: "remove env.ANTHROPIC_BASE_URL, env.ANTHROPIC_AUTH_TOKEN" });
    const [run] = backups(home);
    expect(JSON.parse(readFileSync(join(run!, claude), "utf8"))).toEqual(before);
  });

  test("keeps a base URL that points at a gateway the user chose", async () => {
    const home = temp.make("home-");
    const settings = { env: { ANTHROPIC_BASE_URL: "https://gateway.example.com", ANTHROPIC_AUTH_TOKEN: "token" } };
    write(home, claude, settings);

    const report = await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual(settings);
    expect(report.actions).toEqual([]);
    expect(backups(home)).toEqual([]);
  });

  test("removes a stale Codex proxy provider and keeps the user's own providers", async () => {
    const home = temp.make("home-");
    write(home, codex, [
      'model = "gpt-5"',
      'model_provider = "fleet-proxy"',
      "",
      "[model_providers.fleet-proxy]",
      'base_url = "http://hub.example.test:8317/v1"',
      "",
      "[model_providers.mine]",
      'base_url = "https://llm.example.com/v1"',
      "",
    ].join("\n"));

    await apply(plan(), { home, adapters: adapters() });

    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual({ model: "gpt-5", model_providers: { mine: { base_url: "https://llm.example.com/v1" } } });
  });

  test("keeps a proxy key that a pack owns", async () => {
    const home = temp.make("home-");
    const config = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }];

    await apply(plan(config), { home, adapters: adapters() });
    await apply(plan(config), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    expect(read(home, record)).toEqual({ [claude]: [{ path: ["env", "ANTHROPIC_BASE_URL"], value: "http://127.0.0.1:8317", pack: "hub" }] });
  });

  test("merges owned keys into existing settings and removes a key once no pack owns it", async () => {
    const home = temp.make("home-");
    write(home, claude, { theme: "dark", permissions: { allow: ["Bash(ls)"] } });
    write(home, codex, "# my notes\nmodel = \"gpt-5\"\n");
    const owned = plan([
      { provider: "claude", key: "permissions.defaultMode", value: "acceptEdits" },
      { provider: "codex", key: "features.web_search", value: true, pack: "pull-requests" },
    ]);

    await apply(owned, { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ theme: "dark", permissions: { allow: ["Bash(ls)"], defaultMode: "acceptEdits" } });
    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual({ model: "gpt-5", features: { web_search: true } });

    const second = await apply(owned, { home, adapters: adapters() });
    expect(second.actions).toEqual([]);

    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ theme: "dark", permissions: { allow: ["Bash(ls)"] } });
    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual({ model: "gpt-5" });
    expect(read(home, record)).toEqual({});
  });

  test("keeps a local edit to an owned key until the user adopts Fleet's value", async () => {
    const home = temp.make("home-");
    const owned = plan([{ provider: "claude", key: "permissions.defaultMode", value: "acceptEdits" }]);
    await apply(owned, { home, adapters: adapters() });
    write(home, claude, { permissions: { defaultMode: "plan" } });

    const kept = await apply(owned, { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ permissions: { defaultMode: "plan" } });
    expect(kept.findings).toContainEqual({ id: `kept:${claude}`, pack: "engine", say: `Kept your permissions.defaultMode in ${claude}. Run fleet apply --adopt ${claude} to take Fleet's value.` });
    expect((await check(owned, { home, adapters: adapters() })).ok).toBe(false);

    await apply(owned, { home, adopt: [claude], adapters: adapters() });
    expect(read(home, claude)).toEqual({ permissions: { defaultMode: "acceptEdits" } });
  });

  test("keeps a removed key that the user changed", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "model", value: "opus" }]), { home, adapters: adapters() });
    write(home, claude, { model: "sonnet" });

    await apply(plan(), { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ model: "sonnet" });
    expect(read(home, record)).toEqual({ [claude]: [{ path: ["model"], value: "opus", pack: "base" }] });
  });

  test("removes a key that an earlier Fleet recorded without an owning pack", async () => {
    const home = temp.make("home-");
    write(home, claude, { env: { ENABLE_TOOL_SEARCH: "true", MINE: "1" } });
    write(home, record, { [claude]: [{ path: ["env", "ENABLE_TOOL_SEARCH"], value: "true" }] });

    await apply(plan(), { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ env: { MINE: "1" } });
  });

  test("previews changes without writing, and check fails until they are applied", async () => {
    const home = temp.make("home-");
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "http://localhost:8317/" } });

    const preview = await apply(plan(), { home, dryRun: true, adapters: adapters() });
    expect(preview.findings).toContainEqual({ id: `config:${claude}`, pack: "engine", say: `${claude} needs an update: remove env.ANTHROPIC_BASE_URL.`, repair: "apply" });
    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://localhost:8317/" } });
    expect((await check(plan(), { home, adapters: adapters() })).ok).toBe(false);

    await apply(plan(), { home, adapters: adapters() });
    expect((await check(plan(), { home, adapters: adapters() })).ok).toBe(true);
  });

  test("writes no Cursor config and leaves t3 entries to the T3 adapter", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "t3", key: "defaultThreadEnvMode", value: "worktree" }]), { home, adapters: adapters() });
    expect(existsSync(join(home, ".cursor"))).toBe(false);
    expect(existsSync(join(home, ".t3"))).toBe(false);
  });

  test("trusts the Codex hooks a pack owns, and drops the trust with the hook", async () => {
    const home = temp.make("home-");
    const hook = { provider: "codex" as const, key: "hooks.UserPromptSubmit", value: [{ hooks: [{ type: "command", command: "fleet-guard", timeout: 10 }] }] };

    await apply(plan([hook]), { home, adapters: adapters() });

    const config = parse(readFileSync(join(home, codex), "utf8")) as { hooks: { state: Record<string, unknown> } };
    expect(config.hooks.state).toEqual({ [`${join(home, codex)}:user_prompt_submit:0:0`]: { trusted_hash: "sha256:aab555051f739465c1259296584ef25cd30fdcd220e6362a4e65e8a41af30f45" } });
    await apply(plan(), { home, adapters: adapters() });
    expect(readFileSync(join(home, codex), "utf8").trim()).toBe("");
  });

  test("leaves a settings file alone when it is a link", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    write(dotfiles, "settings.json", { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    mkdirSync(join(home, ".claude"));
    symlinkSync(join(dotfiles, "settings.json"), join(home, claude));

    const report = await apply(plan(), { home, adapters: adapters() });

    expect(lstatSync(join(home, claude)).isSymbolicLink()).toBe(true);
    expect(read(dotfiles, "settings.json")).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    expect(report.findings).toContainEqual({ id: `kept:${claude}`, pack: "engine", say: `Kept ${claude} because it is a link. Fleet would remove env.ANTHROPIC_BASE_URL there. Make it a plain file in a plain folder to let Fleet change it.` });
  });

  test("leaves a settings file it cannot read as it is", async () => {
    const home = temp.make("home-");
    write(home, claude, "{ not json");

    const report = await apply(plan([{ provider: "claude", key: "model", value: "opus" }]), { home, adapters: adapters() });

    expect(readFileSync(join(home, claude), "utf8")).toBe("{ not json");
    expect(report.findings.find((finding) => finding.id === `kept:${claude}`)?.repair).toBe("human");
  });

  test("leaves a settings file alone when its folder is a link", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    write(dotfiles, "settings.json", { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    symlinkSync(dotfiles, join(home, ".claude"));

    const report = await apply(plan(), { home, adapters: adapters() });

    expect(read(dotfiles, "settings.json")).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    expect(report.findings.map((finding) => finding.id)).toContain(`kept:${claude}`);
  });

  test("keeps a provider whose field a pack owns, and the selection that names it", async () => {
    const home = temp.make("home-");
    write(home, codex, 'model_provider = "hub"\n\n[model_providers.hub]\nbase_url = "http://127.0.0.1:8317/v1"\nname = "Hub"\n');
    await apply(plan([{ provider: "codex", key: "model_providers.hub.base_url", value: "http://127.0.0.1:8317/v1", pack: "hub" }]), { home, adapters: adapters() });
    expect(parse(readFileSync(join(home, codex), "utf8"))).toEqual({ model_provider: "hub", model_providers: { hub: { base_url: "http://127.0.0.1:8317/v1", name: "Hub" } } });
  });

  test("keeps a parent when a pack now owns only a field under it", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env", value: { A: "1", B: "2" } }]), { home, adapters: adapters() });
    await apply(plan([{ provider: "claude", key: "env.A", value: "1" }]), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { A: "1", B: "2" } });
  });

  test("keeps a proxy URL the user changed after Fleet wrote it", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }]), { home, adapters: adapters() });
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "http://localhost:8317" } });
    await apply(plan(), { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://localhost:8317" } });
  });

  test("keeps a proxy URL the user changed when a pack now owns only a field beside it", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env", value: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, pack: "hub" }]), { home, adapters: adapters() });
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "http://localhost:8317" } });
    const narrowed = plan([{ provider: "claude", key: "env.MY_FLAG", value: "1" }]);
    await apply(narrowed, { home, adapters: adapters() });
    await apply(narrowed, { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://localhost:8317", MY_FLAG: "1" } });
  });

  test("removes the token that went with a recorded proxy URL", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }]), { home, adapters: adapters() });
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: "key" } });
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({});
  });

  test("removes nothing while a pack source cannot be fetched", async () => {
    const home = temp.make("home-");
    const hub = [{ provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" }];
    await apply(plan(hub), { home, adapters: adapters() });
    const offline = { ...plan(), packs: [...plan().packs, { name: "hub", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] };

    const report = await apply(offline, { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    expect(read(home, record)[claude]).toHaveLength(1);
    expect(report.findings.map((finding) => finding.id)).toContain("config:outage");
  });

  test("keeps the old hook trust while the user's own hook list is kept", async () => {
    const home = temp.make("home-");
    const hook = (command: string) => ({ provider: "codex" as const, key: "hooks.UserPromptSubmit", value: [{ hooks: [{ type: "command", command }] }] });
    await apply(plan([hook("guard-v1")]), { home, adapters: adapters() });
    const trusted = () => (parse(readFileSync(join(home, codex), "utf8")) as { hooks: { state: Record<string, { trusted_hash: string }> } }).hooks.state;
    const first = trusted();
    const config = parse(readFileSync(join(home, codex), "utf8")) as { hooks: Record<string, unknown> };
    config.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: "my-guard" }] }];
    write(home, codex, stringify(config));

    await apply(plan([hook("guard-v2")]), { home, adapters: adapters() });

    expect(trusted()).toEqual(first);
  });

  test("refuses a key that would reach the object prototype", async () => {
    const home = temp.make("home-");
    await expect(apply(plan([{ provider: "claude", key: "__proto__.polluted", value: true }]), { home, adapters: adapters() })).rejects.toThrow("not a usable settings key");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("stops while another Fleet run holds the lock, and writes nothing", async () => {
    const home = temp.make("home-");
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
    mkdirSync(join(home, ".local/state/fleet/lock"), { recursive: true });
    await expect(apply(plan(), { home, adapters: [claudeCli().adapter] })).rejects.toThrow("Another Fleet operation holds");
    expect(read(home, claude)).toEqual({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" } });
  });

  test("refuses two owned keys where one holds the other", async () => {
    const home = temp.make("home-");
    const config = [{ provider: "claude" as const, key: "env.B", value: "2" }, { provider: "claude" as const, key: "env", value: { A: "1" }, pack: "other" }];
    await expect(apply(plan(config), { home, adapters: adapters() })).rejects.toThrow("overlap");
    expect(existsSync(join(home, claude))).toBe(false);
  });

  test("writes no backup through a linked backups folder", async () => {
    const home = temp.make("home-");
    const elsewhere = temp.make("elsewhere-");
    write(home, claude, { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: "secret" } });
    mkdirSync(join(home, ".local/state/fleet"), { recursive: true });
    symlinkSync(elsewhere, join(home, ".local/state/fleet/backups"));
    await expect(apply(plan(), { home, adapters: [claudeCli().adapter] })).rejects.toThrow("is a link or not a directory");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(read(home, claude).env.ANTHROPIC_AUTH_TOKEN).toBe("secret");
  });

  test("keeps the trust of a hook list the user edited after its pack left", async () => {
    const home = temp.make("home-");
    const hook = { provider: "codex" as const, key: "hooks.UserPromptSubmit", value: [{ hooks: [{ type: "command", command: "guard" }] }] };
    await apply(plan([hook]), { home, adapters: adapters() });
    const config = parse(readFileSync(join(home, codex), "utf8")) as { hooks: { UserPromptSubmit: unknown[]; state: unknown } };
    const trust = config.hooks.state;
    config.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: "mine" }] });
    write(home, codex, stringify(config));

    await apply(plan(), { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });

    expect((parse(readFileSync(join(home, codex), "utf8")) as { hooks: { state: unknown } }).hooks.state).toEqual(trust);
  });

  test("names config files as adoptable targets", () => {
    const targets = providerConfigAdapter().targets(plan([{ provider: "claude", key: "a", value: 1 }, { provider: "codex", key: "b", value: 2 }, { provider: "t3", key: "c", value: 3 }]));
    expect(targets).toEqual([claude, codex]);
  });
});

describe("Claude plugins", () => {
  const enabled = { provider: "claude" as const, key: "enabledPlugins.context7@claude-plugins-official", value: true };

  test("installs an enabled plugin once, and uninstalls it when no pack enables it", async () => {
    const home = temp.make("home-");
    const cli = claudeCli();

    await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    expect(cli.calls.filter((call) => call[2] === "install")).toEqual([["claude", "plugin", "install", "context7@claude-plugins-official", "--scope", "user"]]);

    await apply(plan(), { home, adapters: [cli.adapter] });
    expect(cli.calls.at(-1)).toEqual(["claude", "plugin", "uninstall", "context7@claude-plugins-official", "--scope", "user", "--keep-data"]);
  });

  test("never uninstalls a plugin the user installed", async () => {
    const home = temp.make("home-");
    const cli = claudeCli(["context7@claude-plugins-official"]);

    await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    await apply(plan(), { home, adapters: [cli.adapter] });

    expect(cli.calls.some((call) => call[2] === "install" || call[2] === "uninstall")).toBe(false);
  });

  test("runs Claude Code with the target home", async () => {
    const home = temp.make("home-");
    const homes = new Set<string | undefined>();
    const adapter = providerConfigAdapter({ run: async (_command, options) => (homes.add(options?.home), { code: 0, stdout: "[]" }) });
    await apply(plan([enabled]), { home, adapters: [adapter] });
    expect([...homes]).toEqual([home]);
  });

  test("does not own a plugin whose install failed, so a later user install stays", async () => {
    const home = temp.make("home-");
    const installed: string[] = [];
    const calls: string[][] = [];
    const adapter = providerConfigAdapter({
      run: async (command) => {
        calls.push(command);
        if (command[2] === "list") return { code: 0, stdout: JSON.stringify(installed.map((id) => ({ id, scope: "user", version: "1", enabled: true }))) };
        return { code: command[2] === "install" ? 1 : 0, stdout: "" };
      },
    });
    await apply(plan([enabled]), { home, adapters: [adapter] });
    installed.push("context7@claude-plugins-official");
    await apply(plan(), { home, adapters: [adapter] });
    expect(calls.some((call) => call[2] === "uninstall")).toBe(false);
  });

  test("keeps a plugin id with dots as one key", async () => {
    const home = temp.make("home-");
    const cli = claudeCli();
    await apply(plan([{ provider: "claude", key: "enabledPlugins.my.tool@team.market", value: true }]), { home, adapters: [cli.adapter] });
    expect(read(home, claude)).toEqual({ enabledPlugins: { "my.tool@team.market": true } });
    expect(cli.calls).toContainEqual(["claude", "plugin", "install", "my.tool@team.market", "--scope", "user"]);
  });

  test("installs nothing the user turned off in their settings", async () => {
    const home = temp.make("home-");
    write(home, claude, { enabledPlugins: { "context7@claude-plugins-official": false } });
    const cli = claudeCli();
    await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    expect(cli.calls.some((call) => call[2] === "install")).toBe(false);
    expect(read(home, claude)).toEqual({ enabledPlugins: { "context7@claude-plugins-official": false } });
  });

  test("installs nothing while the settings file is a link", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    write(dotfiles, "settings.json", {});
    mkdirSync(join(home, ".claude"));
    symlinkSync(join(dotfiles, "settings.json"), join(home, claude));
    const cli = claudeCli();
    const report = await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    expect(cli.calls).toEqual([]);
    expect(report.findings.map((finding) => finding.id)).toContain("plugins:claude");
  });

  test("installs nothing while the settings folder is a link, even when the settings already match", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    write(dotfiles, "settings.json", { enabledPlugins: { [enabled.key.slice("enabledPlugins.".length)]: true } });
    symlinkSync(dotfiles, join(home, ".claude"));
    const cli = claudeCli();
    const report = await apply(plan([enabled]), { home, adapters: [cli.adapter] });
    expect(cli.calls).toEqual([]);
    expect(report.findings.map((finding) => finding.id)).toContain("plugins:claude");
  });

  test("reports plugins as pending while Claude Code is not installed", async () => {
    const home = temp.make("home-");
    const adapter = providerConfigAdapter({ run: async () => ({ code: 127, stdout: "" }) });

    const report = await apply(plan([enabled]), { home, adapters: [adapter] });

    expect(report.findings).toContainEqual({ id: "plugins:claude", pack: "engine", say: "Claude Code is not installed yet, so its plugins wait: context7@claude-plugins-official.", repair: "apply" });
  });
});
