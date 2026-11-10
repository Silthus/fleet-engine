import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { providerConfigAdapter } from "../../src/adapters/provider-config/adapter.ts";
import { apply } from "../../src/reconciler/apply.ts";
import { cliProxy, codexProviderTable, type ProxyMachine } from "./lib/cli-proxy.ts";
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

describe("without the Hub pack and the MCP gateway pack", () => {
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
      const packs = shipped.filter((name) => name !== "hub" && name !== "mcp-gateway" && next() < 0.6);
      const overrides = Object.fromEntries(workflows.filter(() => next() < 0.3).map((id) => [id, next() < 0.5]));
      const machine: MachineFile = { schema: 1, role: roles[Math.floor(next() * roles.length)] ?? "mac" };
      const ai = (["claude", "codex", "both"] as const)[Math.floor(next() * 3)];
      const result = plan({ packs, workflows: overrides, plan: ai, devboxes: next() < 0.5 ? ["box"] : [], settings: { "memory.repo": "me/notes" } }, machine);
      expect(hubFree(result)).toBe(true);
    }
  });

  test("the property sees the gateway's keys once either pack is on", () => {
    expect(hubFree(plan({ packs: ["hub"] }))).toBe(false);
    expect(hubFree(plan({ packs: ["mcp-gateway"] }))).toBe(false);
  });
});

describe("the Hub pack", () => {
  test("is off by default, and needs only itself", () => {
    expect(plan().workflows.filter((workflow) => workflow.pack === "hub" && workflow.active)).toEqual([]);
    expect(plan({ packs: ["hub"] }).packs.find((pack) => pack.name === "hub")).toMatchObject({ available: true });
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

  test("declares every value the old hub code hardcoded as a setting with no default value", async () => {
    const manifest = sources[0]!.packs.find((pack) => pack.manifest.name === "hub")!.manifest;
    const declared = Object.fromEntries((manifest.settings ?? []).map((setting) => [setting.key, setting]));
    for (const key of ["hub.alias", "hub.coderUrl", "hub.boxTemplate", "hub.httpsHost", "hub.boxWarmCommand"]) {
      expect([key, key in declared, declared[key]?.default]).toEqual([key, true, undefined]);
    }
    const listed = new Set((manifest.workflows ?? []).flatMap((workflow) => workflow.settings ?? []));
    expect(Object.keys(declared).filter((key) => !listed.has(key))).toEqual([]);
  });

  test("plans the Boxes jobs and the Claude token step on the hub, only the forward restore on a devbox, and nothing when the workflow is off", () => {
    const hub: MachineFile = { schema: 1, role: "hub" };
    const items = (machine: MachineFile, fields: Partial<Profile> = {}) => {
      const result = withBoxes(fields, machine);
      return { jobs: result.jobs.filter((job) => job.pack === "hub" && job.workflow === "boxes").map((job) => `${job.id}: ${job.command.join(" ")} every ${job.schedule.every}${job.schedule.at ? ` at ${job.schedule.at}` : ""}`), human: result.human.filter((step) => step.pack === "hub" && step.workflow === "boxes").map((step) => step.id) };
    };
    expect(items(hub)).toEqual({
      jobs: ["box-sweep: fleet box sweep every 15m", "box-nightly: fleet box nightly every 1d at 02:47", "box-restore: fleet box restore every 5m"],
      human: ["box-claude-token"],
    });
    expect(items(devbox)).toEqual({ jobs: ["box-restore: fleet box restore every 5m"], human: [] });
    expect(items(mac)).toEqual({ jobs: [], human: [] });
    expect(items(hub, { workflows: { boxes: false } })).toEqual({ jobs: [], human: [] });
    expect(plan({ packs: ["hub"] }, hub).jobs.filter((job) => job.pack === "hub" && job.workflow === "boxes")).toEqual([]);
  });

  test("plans the disk watch job only on the hub and only while Disk watch is on, and the threads' folder defaults to home", () => {
    const hub: MachineFile = { schema: 1, role: "hub" };
    const items = (machine: MachineFile, workflows: Record<string, boolean> = {}) => {
      const result = plan({ packs: ["hub"], workflows }, machine);
      return [
        ...result.jobs.filter((job) => job.pack === "hub" && job.workflow === "disk-watch").map((job) => `job ${job.id}: ${job.command.join(" ")} every ${job.schedule.every}`),
        ...result.checks.filter((check) => check.pack === "hub" && check.workflow === "disk-watch").map((check) => `check ${check.id}: ${check.run.join(" ")}`),
      ];
    };
    expect(items(hub)).toEqual(["job disk-watch: fleet disk-watch every 15m"]);
    expect(items(hub, { "disk-watch": false })).toEqual([]);
    expect(items(devbox)).toEqual([]);
    expect(items(mac)).toEqual([]);
    expect(plan({ packs: ["hub"], workflows: { "mcp-gateway": false, "linked-hub": false } }).settings).toMatchObject({ "hub.threadFolder": "~" });
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

describe("the Dream workflow", () => {
  const hub: MachineFile = { schema: 1, role: "hub" };
  const dreamOn = { packs: ["hub", "memory"], workflows: { dream: true }, settings: { ...answers, "memory.repo": "me/notes" } };
  const dreamJobs = (result: Plan) => result.jobs.filter((job) => job.workflow === "dream").map((job) => `${job.id}: ${job.command.join(" ")} every ${job.schedule.every} at ${job.schedule.at}`);

  test("is off by default, because each run spends model tokens, and says so in its risk", () => {
    const workflow = sources[0]!.packs.find((pack) => pack.manifest.name === "hub")!.manifest.workflows!.find((item) => item.id === "dream")!;
    expect(workflow).toMatchObject({ name: "Dream", default: false, needs: ["hub", "gh"] });
    expect(workflow.risk).toMatch(/model/);
    expect(workflow.settings!.every((key) => key.startsWith("hub."))).toBe(true);
    expect(plan({ packs: ["hub"] }, hub).workflows.find((item) => item.id === "dream")).toMatchObject({ active: false, reason: "turned off" });
  });

  test("plans the nightly job only on the hub, and only while Dream is on", () => {
    expect(dreamJobs(plan(dreamOn, hub))).toEqual(["dream: fleet dream run every 1d at 04:10"]);
    expect(dreamJobs(plan(dreamOn, devbox))).toEqual([]);
    expect(dreamJobs(plan(dreamOn, mac))).toEqual([]);
    expect(dreamJobs(plan({ ...dreamOn, workflows: {} }, hub))).toEqual([]);
  });

  test("gives fleet commands its session limit only while Dream is on, which is how the box hook knows to save digests", () => {
    expect(plan(dreamOn, hub).settings["hub.dreamSessions"]).toBe(150);
    expect(plan({ ...dreamOn, workflows: {} }, hub).settings["hub.dreamSessions"]).toBeUndefined();
  });

  test("passes the Memory pack's memory.repo only when the Memory pack is on", () => {
    expect(plan(dreamOn, hub).settings["memory.repo"]).toBe("me/notes");
    expect(plan({ ...dreamOn, packs: ["hub"] }, hub).settings["memory.repo"]).toBeUndefined();
  });

  test("ships the dream and fleet-hub skills with the Hub pack, which has no skills bound to a workflow", () => {
    const skills = (result: Plan) => result.files.map((file) => file.target).filter((target) => /^\.agents\/skills\/(dream|fleet-hub)$/.test(target)).sort();
    expect(skills(plan(dreamOn, hub))).toEqual([".agents/skills/dream", ".agents/skills/fleet-hub"]);
    expect(skills(plan({ packs: [] }, hub))).toEqual([]);
  });
});

describe("the Own-account balancing workflow", () => {
  const hub: MachineFile = { schema: 1, role: "hub" };
  const balancing = { packs: ["hub"], workflows: { "own-account-balancing": true } };
  const manifest = () => sources[0]!.packs.find((pack) => pack.manifest.name === "hub")!.manifest;
  const proxyItems = (result: Plan) => ({
    jobs: result.jobs.filter((job) => job.workflow === "own-account-balancing").map((job) => `${job.id}: ${job.command.join(" ")} every ${job.schedule.every}`),
    steps: result.steps.filter((step) => step.workflow === "own-account-balancing").map((step) => step.id),
    checks: result.checks.filter((check) => check.workflow === "own-account-balancing").map((check) => check.id),
    config: result.config.filter((entry) => entry.workflow === "own-account-balancing").map((entry) => `${entry.provider}:${entry.key}`),
  });
  const nothing = { jobs: [], steps: [], checks: [], config: [] };
  const codexRoute = ["codex:model_provider", "codex:model_providers.fleet-proxy"];

  test("is off by default, needs only the hub, and its risk quotes the Anthropic terms word for word", () => {
    const workflow = manifest().workflows!.find((item) => item.id === "own-account-balancing")!;
    expect(workflow).toMatchObject({ name: "Own-account balancing", default: false, needs: ["hub"] });
    expect(workflow.moment).toBeDefined();
    for (const quote of [
      "https://www.anthropic.com/legal/aup",
      "Do Not Abuse Our Platform",
      "\"Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used\"",
      "https://www.anthropic.com/legal/consumer-terms",
      "\"You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else.\"",
      "\"Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.\"",
      "2026-11-05",
      "only for your own subscriptions, never for someone else's",
    ]) expect(workflow.risk).toContain(quote);
    expect(plan({ packs: ["hub"] }, hub).workflows.find((item) => item.id === "own-account-balancing")).toMatchObject({ active: false, reason: "turned off" });
  });

  test("with the workflow off, the Hub pack plans nothing new on any role", () => {
    for (const machine of [hub, devbox, mac]) expect(proxyItems(plan({ packs: ["hub"] }, machine))).toEqual(nothing);
    expect(plan({ packs: ["hub"] }, hub).settings["hub.proxyAccounts"]).toBeUndefined();
  });

  test("with it on, the hub gets the proxy, its balancer, and the route; a devbox gets only the route; the Mac gets nothing", () => {
    const route = { checks: ["cli-proxy-client", "cli-proxy-codex"], config: ["claude:env.ANTHROPIC_BASE_URL", "claude:apiKeyHelper", ...codexRoute] };
    expect(proxyItems(plan(balancing, hub))).toEqual({ jobs: ["cli-proxy-balance: fleet cli-proxy-balance every 5m"], steps: ["cli-proxy"], ...route });
    expect(proxyItems(plan(balancing, devbox))).toEqual({ jobs: [], steps: [], ...route });
    expect(proxyItems(plan(balancing, mac))).toEqual(nothing);
    expect(plan(balancing, hub).settings["hub.proxyAccounts"]).toBe(2);
  });

  test("Codex goes through the proxy only on the both plan, where the hub runs the proxy; a Claude plan routes Claude only, and a Codex plan routes nothing yet", () => {
    const routed = { jobs: [], steps: [] };
    expect(proxyItems(plan({ ...balancing, plan: "both" }, devbox))).toEqual({ ...routed, checks: ["cli-proxy-client", "cli-proxy-codex"], config: ["claude:env.ANTHROPIC_BASE_URL", "claude:apiKeyHelper", ...codexRoute] });
    expect(proxyItems(plan({ ...balancing, plan: "claude" }, devbox))).toEqual({ ...routed, checks: ["cli-proxy-client"], config: ["claude:env.ANTHROPIC_BASE_URL", "claude:apiKeyHelper"] });
    for (const machine of [hub, devbox]) expect(proxyItems(plan({ ...balancing, plan: "codex" }, machine))).toEqual(nothing);
    for (const ai of ["claude", "codex", "both"] as const) expect(proxyItems(plan({ ...balancing, plan: ai }, mac))).toEqual(nothing);
  });

  test("the planned Codex provider is the table the route switch recognizes as Fleet's own", () => {
    expect(plan(balancing, devbox).config.find((entry) => entry.key === "model_providers.fleet-proxy")?.value).toEqual(codexProviderTable);
  });

  test("a devbox on the both plan gets a Codex config that uses the proxy's Responses route and reads the client key from its private file; a Mac gets none", async () => {
    const codexConfig = async (machine: MachineFile) => {
      const home = temp.make("fleet-codex-route-");
      const result = plan({ ...balancing, plan: "both" }, machine);
      const report = await apply({ ...result, config: result.config.filter((entry) => entry.pack === "hub"), steps: [], checks: result.checks.filter((check) => check.pack === "hub"), jobs: [], human: [] }, { home, adapters: [providerConfigAdapter()], run: async () => 0 });
      expect(report.ok).toBe(true);
      return existsSync(join(home, ".codex/config.toml")) ? parse(readFileSync(join(home, ".codex/config.toml"), "utf8")) : undefined;
    };
    expect(await codexConfig(devbox)).toEqual({
      model_provider: "fleet-proxy",
      model_providers: {
        "fleet-proxy": { name: "Fleet CLI proxy", base_url: "http://127.0.0.1:8317/v1", wire_api: "responses", auth: { command: "/bin/sh", args: ["-c", "cat \"$HOME/.config/fleet/cli-proxy.key\""] } },
      },
    });
    expect(await codexConfig(mac)).toBeUndefined();
  });

  test("sends Claude Code to the loopback proxy, and keeps the client key out of the settings: Claude reads it from a private file", () => {
    const config = plan(balancing, devbox).config.filter((entry) => entry.workflow === "own-account-balancing");
    expect(Object.fromEntries(config.filter((entry) => entry.provider === "claude").map((entry) => [entry.key, entry.value]))).toEqual({ "env.ANTHROPIC_BASE_URL": "http://127.0.0.1:8317", apiKeyHelper: "cat \"$HOME/.config/fleet/cli-proxy.key\"" });
    expect(config.map((entry) => entry.pack)).toEqual(["hub", "hub", "hub", "hub"]);
  });

  test("each provider's route waits for its own check, so one provider down never moves the other", () => {
    const waits = Object.fromEntries(plan({ ...balancing, plan: "both" }, devbox).config.filter((entry) => entry.workflow === "own-account-balancing").map((entry) => [`${entry.provider}:${entry.key}`, entry.after]));
    expect(waits).toEqual({ "claude:env.ANTHROPIC_BASE_URL": "cli-proxy-client", "claude:apiKeyHelper": "cli-proxy-client", "codex:model_provider": "cli-proxy-codex", "codex:model_providers.fleet-proxy": "cli-proxy-codex" });
    const checks = plan({ ...balancing, plan: "both" }, devbox).checks.filter((check) => check.workflow === "own-account-balancing");
    expect(checks.map((check) => check.run.join(" "))).toEqual(["fleet cli-proxy check", "fleet cli-proxy check codex"]);
  });

  describe("apply while the proxy is down", () => {
    const key = "c1".repeat(32);
    const routeOnly = (result: Plan): Plan => ({ ...result, config: result.config.filter((entry) => entry.pack === "hub"), checks: result.checks.filter((check) => check.pack === "hub"), steps: [], jobs: [], human: [] });
    const realCheck = (home: string, models: string[] | "down") => {
      const fetch = async () => (models === "down" ? Promise.reject(new TypeError("connection refused")) : Response.json({ data: models.map((id) => ({ id })) }));
      const machine: ProxyMachine = { home, uid: 1000, user: "me", devboxes: [], release: { version: "", url: "", sha256: "" }, run: async () => ({ code: 0, stdout: "", stderr: "" }), fetch, sleep: async () => {}, readStdin: async () => "", randomKey: () => key, print: () => {} };
      return async (command: string[]) => {
        const words = command.join(" ");
        if (words.endsWith("fleet cli-proxy check codex")) return cliProxy("check", machine, "codex");
        return words.endsWith("fleet cli-proxy check") ? cliProxy("check", machine) : 0;
      };
    };
    const homeWith = (files: Record<string, string> = {}) => {
      const home = temp.make("fleet-route-gate-");
      for (const [path, text] of Object.entries({ ".config/fleet/cli-proxy.key": `${key}\n`, ...files })) {
        mkdirSync(join(home, path, ".."), { recursive: true });
        writeFileSync(join(home, path), text);
      }
      return home;
    };
    const offline = (result: Plan): Plan => ({ ...result, packs: [...result.packs, { name: "team", source: "", ref: "", available: false, reason: "not found; unreachable sources: team" }] });
    const applied = async (home: string, models: string[] | "down", times = 2, shape: (result: Plan) => Plan = routeOnly) => {
      const reports = [];
      for (let run = 0; run < times; run++) reports.push(await apply(shape(routeOnly(plan({ ...balancing, plan: "both" }, devbox))), { home, adapters: [providerConfigAdapter()], run: realCheck(home, models) }));
      const claude = existsSync(join(home, ".claude/settings.json")) ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : {};
      const codex = existsSync(join(home, ".codex/config.toml")) ? parse(readFileSync(join(home, ".codex/config.toml"), "utf8")) : {};
      return { reports, claude, codex };
    };
    const both = ["claude-sonnet-5-5", "gpt-6.1-sol"];

    test("leaves Claude Code and Codex on their own sign-in, names both checks, and the next apply changes nothing", async () => {
      const home = homeWith();
      await applied(home, both, 1);
      const { reports, claude, codex } = await applied(home, "down");
      expect(claude).toEqual({});
      expect(codex).toEqual({});
      expect(reports[0]!.findings.map((finding) => finding.id)).toEqual(["check:cli-proxy-client", "check:cli-proxy-codex"]);
      expect(reports[1]!.actions).toEqual([]);
    });

    test("also removes the Claude settings that connect wrote before any apply", async () => {
      const home = homeWith({ ".claude/settings.json": JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: 'cat "$HOME/.config/fleet/cli-proxy.key"' }) });
      const { claude, reports } = await applied(home, "down");
      expect(claude).toEqual({ model: "opus" });
      expect(reports[1]!.actions).toEqual([]);
    });

    test("removes the settings that connect wrote even while a pack source cannot be fetched", async () => {
      const connected = { model: "opus", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" }, apiKeyHelper: 'cat "$HOME/.config/fleet/cli-proxy.key"' };
      const { claude, reports } = await applied(homeWith({ ".claude/settings.json": JSON.stringify(connected) }), "down", 2, offline);
      expect(claude).toEqual({ model: "opus" });
      expect(reports[1]!.actions).toEqual([]);
    });

    test("keeps a key helper of your own that reads a file beside the proxy key", async () => {
      const mine = { apiKeyHelper: 'my-helper --cache "$HOME/.config/fleet/cli-proxy.key-cache"' };
      const { claude } = await applied(homeWith({ ".claude/settings.json": JSON.stringify(mine) }), "down");
      expect(claude).toEqual(mine);
    });

    test("a proxy that serves Claude but not Codex routes Claude only, and the next apply changes nothing", async () => {
      const { reports, claude, codex } = await applied(homeWith(), ["claude-sonnet-5-5"]);
      expect(claude.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
      expect(codex).toEqual({});
      expect(reports[1]!.actions).toEqual([]);
    });

    test("a Fleet provider table you edited away from the proxy keeps Codex off the proxy on every apply", async () => {
      const mine = { model_provider: "fleet-proxy", model_providers: { "fleet-proxy": { name: "Mine" } } };
      const { reports, codex } = await applied(homeWith({ ".codex/config.toml": stringify(mine) }), both, 4);
      expect(codex.model_providers).toEqual(mine.model_providers);
      expect(codex.model_provider).toBe("fleet-proxy");
      expect(reports.slice(1).map((report) => report.actions)).toEqual([[], [], []]);
    });

    test("a proxy that answers routes both", async () => {
      const { claude, codex } = await applied(homeWith(), both);
      expect(claude.apiKeyHelper).toBe("cat \"$HOME/.config/fleet/cli-proxy.key\"");
      expect(codex.model_provider).toBe("fleet-proxy");
    });
  });
});
