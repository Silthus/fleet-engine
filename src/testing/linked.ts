import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main, type CliOptions } from "../cli.ts";
import { filesAdapter } from "../reconciler/apply.ts";
import type { MachineFile } from "../pack/types.ts";
import type { Clock } from "../runner/context.ts";
import type { tempDirs } from "./git.ts";
import { engineSteps } from "./packs.ts";
import { fakeSsh, remoteFleet, type Host } from "./ssh.ts";

const repoRoot = join(import.meta.dir, "../..");
export const hubMachine: MachineFile = { schema: 1, role: "linux", name: "hub-1" };
export const nodeMachine: MachineFile = { schema: 1, role: "devbox", coder: true, name: "node-2" };
export const macMachine: MachineFile = { schema: 1, role: "mac", name: "laptop-3" };

/** A hub and a node on one profile with the issued fixture pack, each on its own temporary home, and an ssh between them that runs its remote line in a shell. port moves the issued service off its fixture port, and nodeClock is the clock the node runs on. */
export function linkedFleets(temp: ReturnType<typeof tempDirs>, port?: number, nodeClock?: Clock) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(repoRoot, "src/reconciler/fixtures/issued"), join(engine, "packs/issued"), { recursive: true });
  const pack = join(engine, "packs/issued/pack.ts");
  if (port) writeFileSync(pack, readFileSync(pack, "utf8").replace("port: 4600,", `port: ${port},`));
  const profile = temp.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["issued"], plan: "claude", settings: {}, workflows: {}, hub: "hub-1", devboxes: ["node-2"] }));
  const hosts: Record<string, Host | "down"> = {};
  const ssh = fakeSsh(temp.make("ssh-"), hosts);
  const machine = (saved: MachineFile, clock?: Clock, platform: NodeJS.Platform = "linux") => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ ...saved, profileDir: profile }));
    const options: CliOptions = {
      home,
      engineRoot: engine,
      platform,
      env: {},
      print: () => {},
      hostname: () => saved.name!,
      capture: ssh,
      run: engineSteps(engine, (args) => main(args, options)),
      adapters: () => [filesAdapter],
      ...(clock ? { clock } : {}),
    };
    const fleet = remoteFleet(() => options);
    const typed = async (...args: string[]) => {
      const { code, stdout, stderr } = await fleet(args);
      return { code, output: (stdout + stderr).trimEnd() };
    };
    return { fleet, typed };
  };
  const hub = machine(hubMachine);
  hosts["hub-1"] = hub.fleet;
  return { hub: hub.typed, hubFleet: hub.fleet, node: machine(nodeMachine, nodeClock).typed, other: (saved: MachineFile) => machine(saved).typed, mac: () => machine(macMachine, undefined, "darwin").typed, hosts, profile };
}
