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
const claudeJson = ".claude.json";
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
    handlers: {},
    settings: {},
    unanswered: [],
    ask: [],
    dropped: [],
    models: [],
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

  test("keeps the user's keys when a pack narrows from a parent they edited", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env", value: { A: "1" } }]), { home, adapters: adapters() });
    write(home, claude, { env: { A: "mine" } });
    const narrowed = plan([{ provider: "claude", key: "env.MY_FLAG", value: "1" }]);
    await apply(narrowed, { home, adapters: adapters() });
    await apply(narrowed, { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { A: "mine", MY_FLAG: "1" } });
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { A: "mine" } });
  });

  test("keeps released keys when a pack narrows to a key the user added, then drops it", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env", value: { A: "1", B: "2" } }]), { home, adapters: adapters() });
    write(home, claude, { env: { A: "1", B: "2", C: "user" } });
    const narrowed = plan([{ provider: "claude", key: "env.C", value: "user" }]);
    await apply(narrowed, { home, adapters: adapters() });
    await apply(narrowed, { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { A: "1", B: "2" } });
  });

  test("keeps a released Codex table when a pack narrows to a field the user added, then drops it", async () => {
    const home = temp.make("home-");
    const sample = { name: "Sample", wire_api: "responses" };
    await apply(plan([{ provider: "codex", key: "model_providers", value: { sample } }]), { home, adapters: adapters() });
    writeFileSync(join(home, codex), `[model_providers.sample]\nname = "Sample"\nwire_api = "responses"\nenv_key = "KEY"\n`);
    const narrowed = plan([{ provider: "codex", key: "model_providers.sample.env_key", value: "KEY" }]);
    await apply(narrowed, { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });
    expect(readFileSync(join(home, codex), "utf8")).toContain('[model_providers.sample]\nname = "Sample"\nwire_api = "responses"');
    expect(readFileSync(join(home, codex), "utf8")).not.toContain("env_key");
  });

  test("releases an unedited parent when a pack narrows to a new field, and keeps it when that field leaves", async () => {
    const home = temp.make("home-");
    await apply(plan([{ provider: "claude", key: "env", value: { A: "1", B: "2" } }]), { home, adapters: adapters() });
    await apply(plan([{ provider: "claude", key: "env.C", value: "3" }]), { home, adapters: adapters() });
    await apply(plan(), { home, adapters: adapters() });
    expect(read(home, claude)).toEqual({ env: { A: "1", B: "2" } });
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

  test("while a source is out, removes a setting whose check fails, and keeps a setting the outage hides", async () => {
    const home = temp.make("home-");
    const proxy = { provider: "claude" as const, key: "env.ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8317", pack: "hub" };
    const model = { provider: "claude" as const, key: "model", value: "opus", pack: "team" };
    await apply(plan([proxy, model]), { home, adapters: adapters() });
    const offline = { ...plan(), packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }], dropped: [{ pack: "hub", item: "config claude:env.ANTHROPIC_BASE_URL", reason: "check proxy-ready does not pass", check: "proxy-ready" }] };

    await apply(offline, { home, adapters: adapters() });

    expect(read(home, claude)).toEqual({ model: "opus" });
    expect(read(home, record)[claude]).toEqual([{ path: ["model"], value: "opus", pack: "team" }]);
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
    expect(providerConfigAdapter().targets(plan([{ provider: "claude", key: "mcpServers.metabase", value: {} }]))).toEqual([claudeJson]);
  });
});

describe("Claude MCP servers", () => {
  const metabase = { type: "stdio", command: "fleet", args: ["posthog-mcp", "metabase"] };
  const server = { provider: "claude" as const, key: "mcpServers.metabase", value: metabase, pack: "posthog" };
  const claudeState = { numStartups: 41, oauthAccount: { emailAddress: "nora@example.com" }, env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, projects: { "/work/app": { allowedTools: [] } }, mcpServers: { mine: { type: "http", url: "http://localhost:9000/mcp" } } };
  const serverRecord = ".config/fleet/claude-servers.json";

  /** Behaves like claude mcp add-json and remove at user scope: each call reads ~/.claude.json fresh and writes it whole. */
  function claudeMcp(options: { normalize?: (value: Record<string, unknown>) => unknown; missing?: boolean; beforeEachCall?: (home: string, command: string[]) => void; refuse?: (command: string[]) => boolean } = {}) {
    const calls: string[][] = [];
    const run: CommandRunner = async (command, runOptions) => {
      calls.push(command);
      if (options.missing) return { code: 127, stdout: "" };
      if (command[1] === "mcp") expect(runOptions?.clearEnv).toEqual(["CLAUDE_CONFIG_DIR"]);
      if (options.refuse?.(command)) return { code: 1, stdout: "", stderr: "refused" };
      if (command[1] === "plugin") return { code: 0, stdout: command[2] === "list" ? "[]" : "" };
      const home = runOptions!.home!;
      options.beforeEachCall?.(home, command);
      const path = join(home, claudeJson);
      const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      const servers = (state.mcpServers ??= {});
      const name = command[3]!;
      if (command[2] === "add-json") {
        if (servers[name]) return { code: 1, stdout: "", stderr: `MCP server ${name} already exists in user config` };
        const value = JSON.parse(command[4]!);
        servers[name] = options.normalize ? options.normalize(value) : value;
      } else if (command[2] === "remove") {
        if (!servers[name]) return { code: 1, stdout: "", stderr: `No MCP server named "${name}" in user scope` };
        delete servers[name];
      }
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
      return { code: 0, stdout: "" };
    };
    return { calls, run, adapters: [filesAdapter, providerConfigAdapter({ run })], mcp: () => calls.filter((call) => call[1] === "mcp") };
  }

  test("go in and out through claude mcp, so Claude Code writes ~/.claude.json and keeps its own keys and a server the user added", async () => {
    const home = temp.make("home-");
    write(home, claudeJson, claudeState);
    const cli = claudeMcp();

    const added = await apply(plan([server]), { home, adapters: cli.adapters });
    expect(cli.mcp()).toEqual([["claude", "mcp", "add-json", "metabase", JSON.stringify(metabase), "--scope", "user"]]);
    expect(read(home, claudeJson)).toEqual({ ...claudeState, mcpServers: { ...claudeState.mcpServers, metabase } });
    expect(added.actions).toContainEqual({ target: claudeJson, operation: "replace", reason: "set mcpServers.metabase" });
    expect(existsSync(join(home, claude))).toBe(false);
    expect(read(home, serverRecord)).toEqual({ servers: [{ name: "metabase", value: metabase, pack: "posthog", stored: metabase }] });

    await apply(plan([server]), { home, adapters: cli.adapters });
    expect(cli.mcp()).toHaveLength(1);

    const removed = await apply(plan(), { home, adapters: cli.adapters });
    expect(cli.mcp().at(-1)).toEqual(["claude", "mcp", "remove", "metabase", "--scope", "user"]);
    expect(read(home, claudeJson)).toEqual(claudeState);
    expect(removed.actions).toContainEqual({ target: claudeJson, operation: "replace", reason: "remove mcpServers.metabase" });
    expect(read(home, serverRecord)).toEqual({ servers: [] });
  });

  test("lose nothing Claude Code saves while Fleet applies, because Fleet never writes ~/.claude.json itself", async () => {
    const home = temp.make("home-");
    write(home, claudeJson, claudeState);
    const cli = claudeMcp({ beforeEachCall: (dir) => write(dir, claudeJson, { ...read(dir, claudeJson), numStartups: 42 }) });
    await apply(plan([server]), { home, adapters: cli.adapters });
    expect(read(home, claudeJson)).toEqual({ ...claudeState, numStartups: 42, mcpServers: { ...claudeState.mcpServers, metabase } });
  });

  test("claim nothing from a failed add, and keep owning a server whose removal failed", async () => {
    const home = temp.make("home-");
    let refuse = true;
    const failing = claudeMcp({ refuse: (command) => refuse && command[2] === "remove" });
    await apply(plan([{ ...server, value: { type: "stdio", command: "old" } }]), { home, adapters: claudeMcp().adapters });
    const report = await apply(plan([server]), { home, adapters: failing.adapters });
    expect(failing.mcp().map((call) => call[2])).toEqual(["remove"]);
    expect(report.findings.map((finding) => finding.id)).toContain("claude-server:metabase");
    expect(read(home, serverRecord).servers).toEqual([{ name: "metabase", value: { type: "stdio", command: "old" }, pack: "posthog", stored: { type: "stdio", command: "old" } }]);
    refuse = false;
    await apply(plan([server]), { home, adapters: failing.adapters });
    expect(read(home, claudeJson).mcpServers.metabase).toEqual(metabase);

    const raced = temp.make("home-");
    const theirs = { type: "stdio", command: "someone-else" };
    const racing = claudeMcp({ beforeEachCall: (dir, command) => void (command[2] === "add-json" && write(dir, claudeJson, { mcpServers: { metabase: theirs } })) });
    await apply(plan([server]), { home: raced, adapters: racing.adapters });
    expect(existsSync(join(raced, serverRecord))).toBe(false);
    const after = await apply(plan(), { home: raced, adapters: claudeMcp().adapters });
    expect(read(raced, claudeJson).mcpServers.metabase).toEqual(theirs);
    expect(after.actions).toEqual([]);
  });

  test("keep a server of the same name that the user wrote, until they adopt Fleet's", async () => {
    const home = temp.make("home-");
    const theirs = { type: "stdio", command: "my-metabase" };
    write(home, claudeJson, { mcpServers: { metabase: theirs } });
    const cli = claudeMcp();

    const report = await apply(plan([server]), { home, adapters: cli.adapters });
    expect(cli.mcp()).toEqual([]);
    expect(report.findings).toContainEqual({ id: `kept:${claudeJson}`, pack: "engine", say: `Kept your mcpServers.metabase in ${claudeJson}. Run fleet apply --adopt ${claudeJson} to take Fleet's value.` });

    await apply(plan([server]), { home, adapters: cli.adapters, adopt: [claudeJson] });
    expect(cli.mcp().map((call) => call[2])).toEqual(["remove", "add-json"]);
    expect(read(home, claudeJson)).toEqual({ mcpServers: { metabase } });

    write(home, claudeJson, { mcpServers: { metabase: theirs } });
    const edited = await apply(plan(), { home, adapters: cli.adapters });
    expect(cli.mcp()).toHaveLength(2);
    expect(read(home, claudeJson)).toEqual({ mcpServers: { metabase: theirs } });
    expect(edited.findings.map((finding) => finding.id)).not.toContain(`kept:${claudeJson}`);
  });

  test("settle on the shape Claude Code stores, and replace the server when the pack changes it", async () => {
    const home = temp.make("home-");
    const cli = claudeMcp({ normalize: (value) => ({ args: [], ...value }) });
    const bare = { ...server, value: { type: "stdio", command: "fleet" } };
    await apply(plan([bare]), { home, adapters: cli.adapters });
    await apply(plan([bare]), { home, adapters: cli.adapters });
    expect(cli.mcp()).toHaveLength(1);
    await apply(plan([server]), { home, adapters: cli.adapters });
    expect(cli.mcp().slice(1).map((call) => call[2])).toEqual(["remove", "add-json"]);
    expect(read(home, claudeJson).mcpServers.metabase).toEqual(metabase);
  });

  test("keep a server name with dots as one key, and leave Claude's plugins to its settings file", async () => {
    const home = temp.make("home-");
    const cli = claudeCli();
    const plugin = { provider: "claude" as const, key: "enabledPlugins.context7@claude-plugins-official", value: true };
    await apply(plan([plugin, { ...server, key: "mcpServers.team.metabase" }]), { home, adapters: [cli.adapter] });
    expect(cli.calls).toContainEqual(["claude", "mcp", "add-json", "team.metabase", JSON.stringify(metabase), "--scope", "user"]);
    expect(read(home, claude)).toEqual({ enabledPlugins: { "context7@claude-plugins-official": true } });
    expect(cli.calls).toContainEqual(["claude", "plugin", "install", "context7@claude-plugins-official", "--scope", "user"]);
  });

  test("wait while Claude Code is missing, report a server it refuses, keep a server through an outage, and change nothing in doctor", async () => {
    const home = temp.make("home-");
    const missing = await apply(plan([server]), { home, adapters: claudeMcp({ missing: true }).adapters });
    expect(missing.findings).toContainEqual({ id: "claude-servers", pack: "engine", say: "Claude Code is not installed yet, so its MCP servers wait: metabase.", repair: "apply" });
    expect(existsSync(join(home, serverRecord))).toBe(false);

    write(home, claudeJson, { mcpServers: {} });
    const refusing: CommandRunner = async (command) => (command[1] === "mcp" ? { code: 1, stdout: "", stderr: "Invalid configuration: : Invalid input" } : { code: 0, stdout: "[]" });
    const refused = await apply(plan([server]), { home, adapters: [filesAdapter, providerConfigAdapter({ run: refusing })] });
    expect(refused.findings).toContainEqual({ id: "claude-server:metabase", pack: "engine", say: "Claude Code did not add the MCP server metabase: Invalid configuration: : Invalid input. Check its value in the posthog pack.", repair: "apply" });

    const cli = claudeMcp();
    await apply(plan([server]), { home, adapters: cli.adapters });
    const report = await check(plan([{ ...server, value: { ...metabase, args: [] } }]), { home, adapters: cli.adapters, run: async () => 0 });
    expect(report.findings).toContainEqual({ id: `config:${claudeJson}`, pack: "engine", say: `${claudeJson} needs an update: set mcpServers.metabase.`, repair: "apply" });
    const outage = plan();
    outage.packs = [{ name: "posthog", source: "posthog", ref: "main", available: false, reason: "not found; unreachable source posthog" }];
    await apply(outage, { home, adapters: cli.adapters });
    expect(cli.mcp()).toHaveLength(1);
    expect(read(home, claudeJson).mcpServers.metabase).toEqual(metabase);
  });

  test("while a source is out, remove a server whose check fails", async () => {
    const home = temp.make("home-");
    const cli = claudeMcp();
    await apply(plan([server]), { home, adapters: cli.adapters });
    const outage = { ...plan(), packs: [...plan().packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }], dropped: [{ pack: "posthog", item: "config claude:mcpServers.metabase", reason: "check gateway-ready does not pass", check: "gateway-ready" }] };

    await apply(outage, { home, adapters: cli.adapters });

    expect(cli.mcp().at(-1)).toEqual(["claude", "mcp", "remove", "metabase", "--scope", "user"]);
    expect(read(home, claudeJson).mcpServers).toEqual({});
  });

  test("leave ~/.claude.json as it is while it is a link", async () => {
    const home = temp.make("home-");
    const dotfiles = temp.make("dotfiles-");
    write(dotfiles, "claude.json", claudeState);
    symlinkSync(join(dotfiles, "claude.json"), join(home, claudeJson));
    const cli = claudeMcp();
    const report = await apply(plan([server]), { home, adapters: cli.adapters });
    expect(cli.mcp()).toEqual([]);
    expect(read(dotfiles, "claude.json")).toEqual(claudeState);
    expect(report.findings.map((finding) => finding.id)).toContain(`kept:${claudeJson}`);
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
