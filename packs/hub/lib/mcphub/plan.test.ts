import { afterEach, beforeAll, expect, test } from "bun:test";
import type { AvailableSource, MachineFile, Profile } from "../../../../src/pack/types.ts";
import { tempDirs } from "../../../../src/testing/git.ts";
import { devbox, engineSource, mac, resolveEngine, skillSources } from "../../../../src/testing/packs.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let sources: AvailableSource[];
beforeAll(async () => {
  const engine = await engineSource();
  sources = [engine, ...skillSources(temp.make("skills-"), engine)];
});

const hub: MachineFile = { schema: 1, role: "hub" };
const answers = { "hub.alias": "my-hub", "hub.coderUrl": "https://coder.example.com", "hub.boxTemplate": "linux" };
const gateway = (fields: Partial<Profile>, machine: MachineFile) => {
  const plan = resolveEngine(sources, { packs: ["hub"], settings: answers, ...fields }, machine);
  return { steps: plan.steps.filter((step) => step.workflow === "mcp-gateway").map((step) => [step.id, step.run, step.check]), checks: plan.checks.filter((check) => check.workflow === "mcp-gateway").map((check) => [check.id, check.run]), settings: plan.settings, commands: plan.commands };
};

test("the hub installs MCPHub as a step checked by doctor, and every machine checks its key, only while the MCP gateway is on", () => {
  const check = ["mcphub-client", ["fleet", "mcphub", "check"]];
  expect(gateway({}, hub)).toMatchObject({ steps: [["mcphub", ["fleet", "mcphub", "install"], ["fleet", "mcphub", "doctor"]]], checks: [check] });
  for (const machine of [devbox, mac]) expect(gateway({}, machine)).toMatchObject({ steps: [], checks: [check] });
  for (const machine of [hub, devbox, mac]) expect(gateway({ workflows: { "mcp-gateway": false } }, machine)).toMatchObject({ steps: [], checks: [] });
  expect(resolveEngine(sources, { settings: answers }, hub).checks.filter((check) => check.pack === "hub")).toEqual([]);
});

test("the MCP gateway gets the hub's HTTPS host and relay port, and ships the mcphub command", () => {
  const plan = gateway({ workflows: { "linked-hub": false }, settings: { ...answers, "hub.httpsHost": "hub.internal.example.com" } }, devbox);
  expect(plan.settings).toMatchObject({ "hub.alias": "my-hub", "hub.httpsHost": "hub.internal.example.com", "hub.relayPort": 60001 });
  expect(plan.commands.mcphub?.pack).toBe("hub");
});
