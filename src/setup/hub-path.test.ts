import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { diskWatchTargets } from "../../packs/hub/lib/disk-watch.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { engineRoot, fakeMachine, fleetSetup, githubRepo, pushedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const coderWorkspace = (name: string) => ({ CODER: "true", CODER_AGENT_URL: "https://coder.example.com", CODER_WORKSPACE_NAME: name });

/** The hub as its own machine: a home with a clone of the profile, in the Coder workspace fleet-hub. */
async function hubMachine(remote: string) {
  const home = temp.make("hub-home-");
  const profile = join(home, ".local/share/fleet/profile");
  await spawnGit(home, "clone", "-q", remote, profile);
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "devbox", profileDir: profile }));
  const lines: string[] = [];
  const fleet = (args: string[]) => main(args, { home, engineRoot, platform: "linux", env: coderWorkspace("fleet-hub"), print: (line) => lines.push(line), apply: async () => 0, hostname: () => "fleet-hub" });
  return { home, profile, fleet, output: () => lines.join("\n") };
}

test("the setup guide's hub path: the Mac adds the hub, the hub names itself, the Mac turns the Hub pack on and adds the node, and the hub's disk watch sees the node", async () => {
  const mac = temp.make("mac-home-");
  expect((await fleetSetup(mac, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(mac), undefined, 0, "darwin")).code).toBe(0);
  const io = scripted([]);
  const onMac = (args: string[], box = fakeMachine(mac)) => main(args, { home: mac, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: box.machine } });

  expect(await onMac(["devbox", "add", "coder.fleet-hub"])).toBe(0);
  const hub = await hubMachine(githubRepo(mac, "nora/fleet-profile"));
  expect(await hub.fleet(["hub", "here"])).toBe(0);
  expect(hub.output()).toStartWith("✓ Saved the hub, coder.fleet-hub, in your profile and pushed it.");

  expect(await onMac(["packs", "--add", "hub", "--workflows", "boxes=off,mcp-gateway=off"])).toBe(0);
  const node = fakeMachine(mac);
  expect(await onMac(["devbox", "add", "coder.fleet-node-1"], node)).toBe(0);
  expect(node.hubUpdates).toEqual(["coder.fleet-hub"]);
  expect(await pushedAnswers(mac)).toMatchObject({ hub: "coder.fleet-hub", packs: expect.arrayContaining(["hub"]), workflows: expect.objectContaining({ boxes: false, "mcp-gateway": false }), devboxes: ["coder.fleet-hub", "coder.fleet-node-1"] });

  await spawnGit(hub.profile, "pull", "-q");
  expect(diskWatchTargets({ FLEET_PROFILE_DIR: hub.profile }, hub.home, "coder.fleet-hub", "fleet-hub")).toEqual({ local: "coder.fleet-hub", remote: ["coder.fleet-node-1"] });
});
