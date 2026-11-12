import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { providerConfigAdapter, type CommandRunner } from "../../src/adapters/provider-config/adapter.ts";
import type { AiPlan, AvailableSource } from "../../src/pack/types.ts";
import { apply, check } from "../../src/reconciler/apply.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, resolveEngine, skillSources } from "../../src/testing/packs.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

function providers() {
  const installed = { claude: [] as string[], codex: [] as string[] };
  const marketplaces: string[] = [];
  const run: CommandRunner = async (command) => {
    const [cli, , verb, ...rest] = command as ["claude" | "codex", string, string, ...string[]];
    if (verb === "list" && cli === "claude") return { code: 0, stdout: JSON.stringify(installed.claude.map((id) => ({ id, scope: "user", version: "1", enabled: true }))) };
    if (verb === "list") return { code: 0, stdout: JSON.stringify({ installed: installed.codex.map((pluginId) => ({ pluginId, installed: true, enabled: true })), available: [] }) };
    if (verb === "marketplace" && rest[0] === "list") return { code: 0, stdout: "[]" };
    if (verb === "marketplace" && rest[0] === "add") marketplaces.push(rest[1]!);
    if (verb === "install" || verb === "add") installed[cli].push(rest[0]!);
    return { code: 0, stdout: "" };
  };
  return { installed, marketplaces, adapter: providerConfigAdapter({ run }) };
}

async function applyPack(plan: AiPlan, workflows: Record<string, boolean> = {}) {
  const home = temp.make("home-");
  const cli = providers();
  const resolved = resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["integrations"], plan, workflows }, devbox);
  await apply(resolved, { home, adapters: [cli.adapter], run: async () => 1 });
  const codex = (existsSync(join(home, ".codex/config.toml")) ? parse(readFileSync(join(home, ".codex/config.toml"), "utf8")) : {}) as { mcp_servers?: Record<string, unknown> };
  const doctor = await check(resolved, { home, adapters: [cli.adapter], run: async () => 1 });
  const signIns = doctor.findings.flatMap((finding) => (finding.pack === "integrations" && finding.id.startsWith("check:") ? [finding.id.slice("check:".length)] : [])).toSorted();
  return { cli, codex, signIns };
}

describe("the Integrations pack", () => {
  test("with both plans, installs GitHub and Context7 for each provider, and Claude's Codex plugin from OpenAI's marketplace", async () => {
    const { cli, codex, signIns } = await applyPack("both");

    expect(cli.installed.claude.toSorted()).toEqual(["codex@openai-codex", "context7@claude-plugins-official", "github@claude-plugins-official"]);
    expect(cli.installed.codex).toEqual(["github@openai-curated-remote"]);
    expect(cli.marketplaces).toContain("openai/codex-plugin-cc");
    expect(codex.mcp_servers?.context7).toEqual({ url: "https://mcp.context7.com/mcp" });
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
});
