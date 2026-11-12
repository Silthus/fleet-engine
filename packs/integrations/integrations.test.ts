import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { providerConfigAdapter, type CommandRunner } from "../../src/adapters/provider-config/adapter.ts";
import type { AiPlan, AvailableSource } from "../../src/pack/types.ts";
import { apply, check, type Runner } from "../../src/reconciler/apply.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../src/testing/packs.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

function providers() {
  const installed = { claude: [] as string[], codex: [] as string[] };
  const marketplaces: string[] = [];
  const changes: string[][] = [];
  const run: CommandRunner = async (command) => {
    const [cli, , verb, ...rest] = command as ["claude" | "codex", string, string, ...string[]];
    if (verb === "list" && cli === "claude") return { code: 0, stdout: JSON.stringify(installed.claude.map((id) => ({ id, scope: "user", version: "1", enabled: true }))) };
    if (verb === "list") return { code: 0, stdout: JSON.stringify({ installed: installed.codex.map((pluginId) => ({ pluginId, version: "1.0.0", installed: true, enabled: true })), available: [] }) };
    if (verb === "marketplace" && rest[0] === "list") return { code: 0, stdout: "[]" };
    if (verb === "marketplace" && rest[0] === "add") marketplaces.push(rest[1]!);
    if (verb === "install" || verb === "add") {
      changes.push(command);
      installed[cli].push(rest[0]!);
    }
    return { code: 0, stdout: "{}" };
  };
  return { installed, marketplaces, changes, adapter: providerConfigAdapter({ run }) };
}

const signedIn = {
  claude: (server: string) => `${server}:\n  Scope: Dynamic config (from command line)\n  Status: ✓ Connected\n  Type: http\n`,
  codex: (auth: string) => `Name      Url                           Bearer Token Env Var  Status   Auth\ncontext7  https://mcp.context7.com/mcp  -                     enabled  ${auth}\n`,
};
const signedOut = { claude: (server: string) => `${server}:\n  Scope: Dynamic config (from command line)\n  Status: ! Needs authentication\n  Type: http\n` };

type Machine = { claude?: (server: string) => string; codexAuth?: string; convex?: boolean; env?: Record<string, string> };

/** Runs each check with fake claude and codex CLIs that print what the real ones print. */
function checkRunner(home: string, machine: Machine): Runner {
  const bin = temp.make("bin-");
  for (const server of ["plugin:github:github", "plugin:context7:context7"]) writeFileSync(join(bin, server.replaceAll(":", "_")), (machine.claude ?? signedOut.claude)(server));
  writeFileSync(join(bin, "codex-mcp-list"), signedIn.codex(machine.codexAuth ?? "Not logged in"));
  writeFileSync(join(bin, "claude"), `#!/bin/sh\n[ "$1 $2" = "mcp get" ] || exit 2\ncat "${bin}/$(printf %s "$3" | tr : _)"\n`);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\n[ "$1 $2" = "mcp list" ] || exit 2\ncat "${bin}/codex-mcp-list"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "codex"), 0o755);
  if (machine.convex) {
    mkdirSync(join(home, ".convex"), { recursive: true });
    writeFileSync(join(home, ".convex/config.json"), "{}");
  }
  const inherited = Object.fromEntries(Object.entries(Bun.env).filter(([name]) => name !== "CONTEXT7_API_KEY"));
  return async (command, env = {}) => Bun.spawn(command, { stdout: "ignore", stderr: "ignore", env: { ...inherited, PATH: `${bin}:${Bun.env.PATH}`, HOME: home, ...machine.env, ...env } }).exited;
}

const resolve = (plan: AiPlan, workflows: Record<string, boolean>) => resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["integrations"], plan, workflows }, devbox);
const signInsOf = (findings: Array<{ pack: string; id: string }>) => findings.flatMap((finding) => (finding.pack === "integrations" && finding.id.startsWith("check:") ? [finding.id.slice("check:".length)] : [])).toSorted();

async function applyPack(plan: AiPlan, workflows: Record<string, boolean> = {}) {
  const home = temp.make("home-");
  const cli = providers();
  const resolved = resolve(plan, workflows);
  await apply(resolved, { home, adapters: [cli.adapter], run: async () => 1 });
  const codex = (existsSync(join(home, ".codex/config.toml")) ? parse(readFileSync(join(home, ".codex/config.toml"), "utf8")) : {}) as { mcp_servers?: Record<string, unknown>; plugins?: Record<string, unknown> };
  const doctor = await check(resolved, { home, adapters: [cli.adapter], run: async () => 1 });
  return { cli, codex, signIns: signInsOf(doctor.findings) };
}

async function doctor(plan: AiPlan, workflows: Record<string, boolean>, machine: Machine) {
  const home = temp.make("home-");
  return signInsOf((await check(resolve(plan, workflows), { home, adapters: [], run: checkRunner(home, machine) })).findings);
}

describe("the Integrations pack", () => {
  test("with both plans, installs GitHub and Context7 for each provider, and Claude's Codex plugin from OpenAI's marketplace", async () => {
    const { cli, codex, signIns } = await applyPack("both");

    expect(cli.installed.claude.toSorted()).toEqual(["codex@openai-codex", "context7@claude-plugins-official", "github@claude-plugins-official"]);
    expect(cli.changes.filter((command) => command[0] === "codex")).toEqual([["codex", "plugin", "add", "github@openai-curated-remote", "--json"]]);
    expect(codex.plugins).toEqual({ "github@openai-curated-remote": { enabled: true } });
    expect(cli.marketplaces).toContain("openai/codex-plugin-cc");
    expect(codex.mcp_servers?.context7).toEqual({ url: "https://mcp.context7.com/mcp", env_http_headers: { CONTEXT7_API_KEY: "CONTEXT7_API_KEY" } });
    expect(signIns).toEqual(["context7-claude", "context7-codex", "github-token"]);
  });

  test("installs Convex only once the profile turns it on, and lists its sign-in then", async () => {
    const { cli, signIns } = await applyPack("both", { convex: true });

    expect(cli.installed.claude).toContain("convex@claude-plugins-official");
    expect(cli.installed.codex).toContain("convex@openai-curated-remote");
    expect(signIns).toContain("convex-login");
  });

  test("with one AI plan, gives the other provider nothing and leaves out the Codex bridge", async () => {
    const claude = await applyPack("claude");
    expect(claude.cli.installed).toEqual({ claude: ["github@claude-plugins-official", "context7@claude-plugins-official"], codex: [] });
    expect(claude.codex.mcp_servers?.context7).toBeUndefined();

    const codex = await applyPack("codex");
    expect(codex.cli.installed).toEqual({ claude: [], codex: ["github@openai-curated-remote"] });
    expect(codex.signIns).toEqual(["context7-codex"]);
  });

  test("doctor passes each sign-in once its provider reports it, and lists only the ones still missing", async () => {
    expect(await doctor("both", { convex: true }, { claude: signedIn.claude, codexAuth: "OAuth", convex: true })).toEqual([]);
    expect(await doctor("both", { convex: true }, { codexAuth: "OAuth" })).toEqual(["context7-claude", "convex-login", "github-token"]);
  });

  test("doctor accepts a Context7 API key in place of Codex's OAuth sign-in", async () => {
    expect(await doctor("codex", {}, { env: { CONTEXT7_API_KEY: "sample" } })).toEqual([]);
    expect(await doctor("codex", {}, { env: { CONTEXT7_API_KEY: "" } })).toEqual(["context7-codex"]);
  });
});
