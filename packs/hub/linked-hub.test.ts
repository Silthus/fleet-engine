import { afterEach, beforeAll, expect, test } from "bun:test";
import type { AvailableSource, MachineFile, Profile } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { devbox, engineSource, mac, resolveEngine } from "../../src/testing/packs.ts";
import { fleetMachine, runFleet } from "../orchestration/lib/testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let sources: AvailableSource[];
beforeAll(async () => void (sources = [await engineSource()]));

const hub: MachineFile = { schema: 1, role: "hub" };
const linux: MachineFile = { schema: 1, role: "linux" };
const linkedHubItems = (machine: MachineFile, fields: Partial<Profile> = {}) => {
  const result = resolveEngine(sources, { packs: ["hub"], settings: { "hub.alias": "my-hub" }, ...fields }, machine);
  const ours = <T extends { pack: string; workflow?: string }>(items: T[]) => items.filter((item) => item.pack === "hub" && item.workflow === "linked-hub");
  return {
    steps: ours(result.steps).map((step) => `${step.id}: ${step.run.join(" ")}, checked by ${step.check?.join(" ")}`),
    jobs: ours(result.jobs).map((job) => `${job.id}: ${job.command.join(" ")} every ${job.schedule.every}${job.schedule.at ? ` at ${job.schedule.at}` : ""}`),
    human: ours(result.human).map((step) => `${step.id}: probed by ${step.probe.join(" ")}`),
  };
};

test("Hub links puts HTTPS and the devbox tunnels on the hub, the hosts entry on a devbox, and the hub tunnel on a Mac, each checked by its doctor", () => {
  const jobs = ["peers-renew: fleet peers renew every 1d at 03:07", "peers-restore: fleet peers restore every 5m"];
  const peers = "peers: fleet peers install, checked by fleet peers doctor";
  expect(linkedHubItems(hub)).toEqual({
    steps: ["hub-https: fleet hub-https install, checked by fleet hub-https doctor", "ssh-tunnels: fleet ssh-tunnels install, checked by fleet ssh-tunnels doctor", peers],
    jobs,
    human: [],
  });
  expect(linkedHubItems(devbox)).toEqual({ steps: ["ssh-tunnels: fleet ssh-tunnels install, checked by fleet ssh-tunnels doctor", peers], jobs, human: [] });
  expect(linkedHubItems(mac)).toEqual({ steps: ["hub-tunnel: fleet hub-tunnel install, checked by fleet hub-tunnel doctor"], jobs: [], human: ["hub-https-trust: probed by fleet hub-https trusted"] });
  expect(linkedHubItems(linux)).toEqual({ steps: [], jobs: [], human: [] });
});

test("the Mac's trust step names the command that prints the hub's certificate and says how to trust it", () => {
  const step = resolveEngine(sources, { packs: ["hub"], settings: { "hub.alias": "my-hub" } }, mac).human.find((item) => item.id === "hub-https-trust")!;
  expect(step.say).toContain("fleet hub-https ca");
  expect(step.say).toContain("Always Trust");
});

test("Hub links plans nothing while the workflow is off or the Hub pack is not on", () => {
  for (const machine of [hub, devbox, mac]) {
    expect(linkedHubItems(machine, { workflows: { "linked-hub": false } })).toEqual({ steps: [], jobs: [], human: [] });
    expect(linkedHubItems(machine, { packs: [] })).toEqual({ steps: [], jobs: [], human: [] });
  }
});

test("through fleet, hub-https doctor passes with no HTTPS host, and peers plan lists the merged peers without this machine", async () => {
  const home = temp.make("fleet-links-cli-");
  const profile = await fleetMachine(home, { "hub.alias": "my-hub" });
  const fleet = await Bun.file(`${profile}/fleet.json`).json();
  await Bun.write(`${profile}/fleet.json`, JSON.stringify({ ...fleet, packs: ["hub"], devboxes: ["box-1", "box-2"] }));
  expect(await runFleet(["hub-https", "doctor"], { HOME: home })).toEqual({ stdout: "Hub HTTPS is off: hub.httpsHost is empty.\n", stderr: "", code: 0 });
  expect(await runFleet(["peers", "plan"], { HOME: home })).toEqual({ stdout: "Peer access plan: my-hub, box-1, box-2\n", stderr: "", code: 0 });
});
