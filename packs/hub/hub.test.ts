import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const withBoxes = (fields: Partial<Profile> = {}, machine: MachineFile = devbox) => resolveEngine([...sources, coderTeam()], { settings: answers, ...fields, packs: [...(fields.packs ?? ["hub"]), "posthog"] }, machine);
function coderTeam(): AvailableSource {
  const dir = temp.make("team-");
  return { ref: { name: "team", repo: "example/team-packs", ref: "main" }, dir, packs: [{ dir, manifest: { schema: 1, name: "posthog", summary: "A team pack that brings Coder." } }] };
}
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

  test("asks setup for the hub's name, and for the Coder address and box template only when a team pack brings Coder", () => {
    expect(resolveEngine(sources, { packs: ["hub"] }, devbox).unanswered.map((setting) => setting.key)).toEqual(["hub.alias"]);
    const team = [...sources, coderTeam()];
    expect(resolveEngine(team, { packs: ["hub", "posthog"] }, devbox).unanswered.map((setting) => setting.key)).toEqual(["hub.alias", "hub.coderUrl", "hub.boxTemplate"]);
    expect(resolveEngine(team, { packs: ["hub", "posthog"], settings: answers }, devbox).unanswered).toEqual([]);
  });

  test("turns Boxes on only when a team pack brings Coder", () => {
    const boxes = (result: Plan) => result.workflows.find((workflow) => workflow.pack === "hub" && workflow.id === "boxes")?.active;
    expect(boxes(plan({ packs: ["hub"] }))).toBe(false);
    expect(boxes(resolveEngine([...sources, coderTeam()], { packs: ["hub", "posthog"], settings: answers }, devbox))).toBe(true);
  });

  test("never asks for the Slack member ID, so a team pack that already asks for it is not asked twice", () => {
    const withTrigger = plan({ packs: ["hub"], workflows: { "slack-trigger": true } });
    expect(withTrigger.ask.map((setting) => setting.key)).not.toContain("hub.slackUserId");
    expect(withTrigger.unanswered.map((setting) => setting.key)).toEqual([]);
  });

  test("declares every value the old hub code hardcoded as a setting with no default value", async () => {
    const manifest = sources[0]!.packs.find((pack) => pack.manifest.name === "hub")!.manifest;
    const declared = Object.fromEntries((manifest.settings ?? []).map((setting) => [setting.key, setting]));
    for (const key of ["hub.alias", "hub.coderUrl", "hub.boxTemplate", "hub.slackUserId", "hub.httpsHost", "hub.boxWarmCommand"]) {
      expect([key, key in declared, declared[key]?.default]).toEqual([key, true, undefined]);
    }
    const listed = new Set((manifest.workflows ?? []).flatMap((workflow) => workflow.settings ?? []));
    expect(Object.keys(declared).filter((key) => !listed.has(key))).toEqual([]);
  });

  test("plans the Boxes jobs on the hub, only the forward restore on a devbox, and nothing when the workflow is off", () => {
    const hub: MachineFile = { schema: 1, role: "hub" };
    const items = (machine: MachineFile, fields: Partial<Profile> = {}) => {
      const result = withBoxes(fields, machine);
      return { jobs: result.jobs.filter((job) => job.pack === "hub" && job.workflow === "boxes").map((job) => `${job.id}: ${job.command.join(" ")} every ${job.schedule.every}${job.schedule.at ? ` at ${job.schedule.at}` : ""}`), human: result.human.filter((step) => step.pack === "hub").map((step) => step.id) };
    };
    expect(items(hub)).toEqual({
      jobs: ["box-sweep: fleet box sweep every 15m", "box-nightly: fleet box nightly every 1d at 02:47", "box-restore: fleet box restore every 5m"],
      human: ["box-claude-token"],
    });
    expect(items(devbox)).toEqual({ jobs: ["box-restore: fleet box restore every 5m"], human: ["box-claude-token"] });
    expect(items(mac)).toEqual({ jobs: [], human: [] });
    expect(items(hub, { workflows: { boxes: false } })).toEqual({ jobs: [], human: [] });
    expect(plan({ packs: ["hub"] }, hub).jobs.filter((job) => job.pack === "hub" && job.workflow === "boxes")).toEqual([]);
  });

  test("the Boxes workflow's settings reach its commands, the relay port for a box's hub forward included", () => {
    const settings = withBoxes({ workflows: { "linked-hub": false } }).settings;
    expect(Object.keys(settings).filter((key) => key.startsWith("hub.box") || key === "hub.relayPort").sort()).toEqual([
      "hub.boxDiskGigabytes", "hub.boxIdleHours", "hub.boxKeepDirs", "hub.boxPoolSize", "hub.boxReapDays", "hub.boxTemplate", "hub.relayPort",
    ]);
  });

  test("the Claude token step tells the person to paste into fleet box token, and its probe passes only for a token file with mode 0600", () => {
    const step = withBoxes({}, { schema: 1, role: "hub" }).human.find((item) => item.id === "box-claude-token")!;
    expect(step).toMatchObject({ command: "claude setup-token", interactive: true, workflow: "boxes" });
    expect(step.say).toContain("fleet box token");
    const home = temp.make("hub-token-");
    const probe = () => Bun.spawnSync(step.probe, { env: { HOME: home, PATH: "/usr/bin:/bin" } }).exitCode;
    expect(probe()).not.toBe(0);
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/box-claude-token"), "sk-test\n", { mode: 0o644 });
    chmodSync(join(home, ".config/fleet/box-claude-token"), 0o644);
    expect(probe()).not.toBe(0);
    chmodSync(join(home, ".config/fleet/box-claude-token"), 0o600);
    expect(probe()).toBe(0);
  });
});
