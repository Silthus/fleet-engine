import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AvailableSource, MachineFile, MachineRole, Plan, Profile } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, mac, resolveEngine, skillSources } from "../../src/testing/packs.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let sources: AvailableSource[];
let shipped: string[];
beforeAll(async () => {
  const engine = await engineSource();
  sources = [engine, ...skillSources(temp.make("skills-"), engine)];
  shipped = engine.packs.map((pack) => pack.manifest.name).filter((name) => name !== "base");
});

const answers = { "hub.alias": "my-hub", "hub.coderUrl": "https://coder.example.com", "hub.boxTemplate": "linux" };
const plan = (fields: Partial<Profile> = {}, machine: MachineFile = devbox) => resolveEngine(sources, { settings: answers, ...fields }, machine);
const gatewayKeys = ["claude:mcpServers.fleet-hub", "codex:mcp_servers.fleet-hub"];

describe("without the Hub pack", () => {
  const pointsAtHub = /\bhub\b|tunnel|proxy|mcphub|ANTHROPIC_BASE_URL|127\.0\.0\.1|localhost/i;
  const roles: MachineRole[] = ["mac", "devbox", "linux"];

  function random(seed: number) {
    return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  }

  function hubFree(result: Plan) {
    const { jobs, human, steps, checks, config, files, commands } = result;
    const contents = files.map((file) => ("content" in file ? file.content : ""));
    const items = JSON.stringify({ jobs, human, steps, checks, config, commands, targets: files.map((file) => file.target) }, (key, value) => (key === "roles" ? undefined : value));
    return !pointsAtHub.test(items) && !contents.some((text) => /mcphub|ANTHROPIC_BASE_URL|127\.0\.0\.1:(8317|3317)/.test(text));
  }

  test("no shipped pack plans an item that points at a hub, tunnel, or proxy, for any packs, workflows, role, or plan", () => {
    const next = random(27);
    const workflows = sources[0]!.packs.flatMap((pack) => (pack.manifest.name === "hub" ? [] : (pack.manifest.workflows ?? []).map((workflow) => workflow.id)));
    for (let run = 0; run < 40; run++) {
      const packs = shipped.filter((name) => name !== "hub" && next() < 0.6);
      const overrides = Object.fromEntries(workflows.filter(() => next() < 0.3).map((id) => [id, next() < 0.5]));
      const machine: MachineFile = { schema: 1, role: roles[Math.floor(next() * roles.length)] ?? "mac" };
      const ai = (["claude", "codex", "both"] as const)[Math.floor(next() * 3)];
      const result = plan({ packs, workflows: overrides, plan: ai, devboxes: next() < 0.5 ? ["box"] : [], settings: { "memory.repo": "me/notes" } }, machine);
      expect(hubFree(result)).toBe(true);
    }
  });

  test("the property sees the Hub pack's keys once the pack is on", () => {
    expect(hubFree(plan({ packs: ["hub"] }))).toBe(false);
  });
});

describe("the Hub pack", () => {
  test("is off by default, and needs only itself", () => {
    expect(plan().workflows.filter((workflow) => workflow.pack === "hub" && workflow.active)).toEqual([]);
    expect(plan({ packs: ["hub"] }).packs.find((pack) => pack.name === "hub")).toMatchObject({ available: true });
  });

  test("owns the MCP gateway keys alone, with every shipped pack on", () => {
    const result = plan({ packs: shipped, settings: { ...answers, "memory.repo": "me/notes" } });
    for (const key of gatewayKeys) expect([key, result.owners[key]]).toEqual([key, "hub"]);
    const gateway = result.config.filter((entry) => gatewayKeys.includes(`${entry.provider}:${entry.key}`));
    expect(gateway.map((entry) => entry.pack)).toEqual(["hub", "hub"]);
  });

  test("gives each plan only its own provider's gateway key, and drops both when the gateway is off", () => {
    const keys = (fields: Partial<Profile>, machine: MachineFile = devbox) => plan({ packs: ["hub"], ...fields }, machine).config.map((entry) => `${entry.provider}:${entry.key}`).filter((key) => gatewayKeys.includes(key));
    expect(keys({ plan: "claude" })).toEqual(["claude:mcpServers.fleet-hub"]);
    expect(keys({ plan: "codex" })).toEqual(["codex:mcp_servers.fleet-hub"]);
    expect(keys({ workflows: { "mcp-gateway": false } })).toEqual([]);
    expect(keys({}, mac)).toEqual(gatewayKeys);
  });

  test("keeps sign-ins and hosts out of the gateway keys: each provider starts fleet mcphub connect, which reads them at run time", () => {
    const result = plan({ packs: ["hub"] });
    for (const entry of result.config.filter((item) => item.pack === "hub")) {
      const text = JSON.stringify(entry.value);
      expect(text).toContain("fleet\\\" mcphub connect");
      expect(text).not.toMatch(/https?:|token|bearer|authorization|127\.0\.0\.1/i);
    }
  });

  test("asks setup for the hub's name, the Coder address, and the box template, which have no default", () => {
    const fresh = resolveEngine(sources, { packs: ["hub"] }, devbox);
    expect(fresh.unanswered.map((setting) => setting.key)).toEqual(["hub.alias", "hub.coderUrl", "hub.boxTemplate"]);
    expect(plan({ packs: ["hub"] }).unanswered).toEqual([]);
  });

  test("asks for the Slack member ID only when the Slack trigger is on, and lets it fall back to the PostHog pack's", () => {
    const asked = (fields: Partial<Profile>) => plan({ packs: ["hub"], ...fields }).ask.map((setting) => setting.key);
    expect(asked({})).not.toContain("hub.slackUserId");
    expect(asked({ workflows: { "slack-trigger": true } })).toContain("hub.slackUserId");
    expect(plan({ packs: ["hub"], workflows: { "slack-trigger": true } }).unanswered.map((setting) => setting.key)).toEqual([]);
  });

  test("declares every value the old hub code hardcoded as a setting with no default value", async () => {
    const manifest = sources[0]!.packs.find((pack) => pack.manifest.name === "hub")!.manifest;
    const declared = Object.fromEntries((manifest.settings ?? []).map((setting) => [setting.key, setting]));
    for (const key of ["hub.alias", "hub.coderUrl", "hub.boxTemplate", "hub.slackUserId", "hub.httpsHost", "hub.boxWarmCommand"]) {
      expect([key, declared[key]?.default]).toEqual([key, undefined]);
    }
    const listed = new Set((manifest.workflows ?? []).flatMap((workflow) => workflow.settings ?? []));
    expect(Object.keys(declared).filter((key) => !listed.has(key))).toEqual([]);
  });
});
