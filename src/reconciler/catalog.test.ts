import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerConfigAdapter } from "../adapters/provider-config/adapter.ts";
import { main, type CliOptions } from "../cli.ts";
import { loadPacks } from "../pack/manifest.ts";
import type { AiPlan, MachineFile, Plan, Profile } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { filesAdapter } from "./apply.ts";
import { resolve } from "./resolve.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "../..");

function engine(extra: Record<string, string> = {}) {
  const dir = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(dir, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/served"), join(dir, "packs/served"), { recursive: true });
  for (const [name, source] of Object.entries(extra)) {
    mkdirSync(join(dir, "packs", name), { recursive: true });
    writeFileSync(join(dir, "packs", name, "pack.ts"), source);
  }
  return dir;
}

const hub: MachineFile = { schema: 1, role: "linux", name: "hub-1" };
const node: MachineFile = { schema: 1, role: "devbox", coder: true, name: "node-2" };
const mac: MachineFile = { schema: 1, role: "mac", name: "laptop" };

async function plan(dir: string, machine: MachineFile, fields: { plan?: AiPlan; workflows?: Record<string, boolean>; packs?: string[] } = {}): Promise<Plan> {
  const profile: Profile = { schema: 1, dir: "/profile", engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: fields.packs ?? ["served"], plan: fields.plan ?? "claude", settings: {}, workflows: fields.workflows ?? {}, hub: "hub-1", devboxes: ["node-2"] };
  return resolve(profile, machine, [{ ref: { name: "engine", repo: "example/engine", ref: "main" }, dir, packs: await loadPacks(dir) }]);
}

const catalog = (plan: Plan) => (plan.catalog ?? []).map((entry) => `${entry.pack}/${entry.id} ${entry.port} ${entry.health}`);

describe("the service catalog", () => {
  test("a node's plan from the same profile holds the hub's served service, though the node runs none of the hub's items", async () => {
    const dir = engine();
    const onHub = await plan(dir, hub);
    const onNode = await plan(dir, node);
    expect(catalog(onHub)).toEqual(["served/served-api 4555 /health"]);
    expect(catalog(onNode)).toEqual(catalog(onHub));
    expect(onNode.human.map((step) => step.id)).not.toContain("served-installed");
    expect(onHub.human.map((step) => step.id)).toContain("served-installed");
  });

  test("the catalog follows the profile's plan and workflows on every node, and judges the os as Linux off the hub", async () => {
    const dir = engine();
    const choices = { plan: "codex" as const, workflows: { "served-extra": true } };
    const all = ["served/served-api 4555 /health", "served/served-extra-api 4556 /health", "served/served-codex-api 4557 /ready"];
    expect(catalog(await plan(dir, hub, choices))).toEqual(all);
    expect(catalog(await plan(dir, node, choices))).toEqual(all);
    expect(catalog(await plan(dir, mac, choices))).toEqual(all);
    expect((await plan(dir, mac, choices)).human.map((step) => step.id)).not.toContain("served-installed");
  });

  test("two packs that claim one port fail at resolve time", async () => {
    const dir = engine({ other: packSource("other", `fleet.service({ on: "hub", id: "other-api", serve: { port: 4555, health: "/health", credential: async () => "x" } });`) });
    await expect(plan(dir, node, { packs: ["served", "other"] })).rejects.toThrow("port 4555 is claimed by both served/served-api and other/other-api");
  });

  test("a pack.ts config key has one owner, like a pack.json one", async () => {
    const dir = engine({ other: packSource("other", `fleet.config({ provider: "codex", key: "mcp_servers.served", value: {} });`) });
    await expect(plan(dir, node, { packs: ["served", "other"] })).rejects.toThrow("codex:mcp_servers.served is owned by both served and other");
  });
});

describe("register refuses a service it cannot place", () => {
  const refused = async (body: string) => loadPacks(engine({ odd: packSource("odd", body) }));
  test("a served service off the hub, a service with neither a process nor serve, and a port out of range", async () => {
    await expect(refused(`fleet.service({ id: "odd-api", serve: { port: 4600, health: "/health", credential: async () => "x" } });`)).rejects.toThrow('service odd-api: serve needs on: "hub"');
    await expect(refused(`fleet.service({ id: "odd-api" } as never);`)).rejects.toThrow("service odd-api needs run, serve, or both");
    await expect(refused(`fleet.service({ on: "hub", id: "odd-api", serve: { port: 70000, health: "/health", credential: async () => "x" } });`)).rejects.toThrow("service odd-api: serve.port must be a port from 1 to 65535");
    await expect(refused(`fleet.service({ on: "hub", id: "odd-api", serve: { port: 4600, health: "health", credential: async () => "x" } });`)).rejects.toThrow("service odd-api: serve.health must be a path that starts with /");
  });
});

describe("fleet.config", () => {
  function machine(saved: MachineFile) {
    const dir = engine();
    const home = temp.make("home-");
    const profile = temp.make("profile-");
    writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["served"], plan: "codex", settings: {}, workflows: {}, hub: "hub-1" }));
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ ...saved, profileDir: profile }));
    const options: CliOptions = {
      home,
      engineRoot: dir,
      platform: "linux",
      env: {},
      print: () => {},
      hostname: () => saved.name!,
      run: async (command) => (command[0] === "/bin/sh" && command[1] === join(dir, "fleet") ? main(command.slice(2), options) : 0),
      adapters: () => [filesAdapter, providerConfigAdapter({ run: async () => ({ code: 0, stdout: "" }) })],
    };
    const codex = () => {
      const path = join(home, ".codex/config.toml");
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    };
    return { fleet: (...args: string[]) => main(args, options), codex };
  }

  test("a config item waits for its check and lands only where its scope places it", async () => {
    const onHub = machine(hub);
    expect(await onHub.fleet("apply")).toBe(0);
    expect(onHub.codex()).toContain("[mcp_servers.served]");
    expect(onHub.codex()).not.toContain("served-admin");
    expect(await onHub.fleet("served", "install")).toBe(0);
    expect(onHub.codex()).toContain("[mcp_servers.served-admin]");

    const onNode = machine(node);
    expect(await onNode.fleet("apply")).toBe(0);
    expect(await onNode.fleet("served", "install")).toBe(0);
    expect(onNode.codex()).toContain("[mcp_servers.served]");
    expect(onNode.codex()).not.toContain("served-admin");
  });
});

function packSource(name: string, body: string) {
  return `export default { sdk: 1, name: "${name}", summary: "A test pack.", register(fleet) { ${body} } };\n`;
}
