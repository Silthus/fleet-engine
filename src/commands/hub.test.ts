import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import { filesAdapter } from "../reconciler/apply.ts";
import { git, isolateGit, tempDirs } from "../testing/git.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "../..");

function fleetMachine(profileFields: Record<string, unknown> = {}, machineFields: Record<string, unknown> = {}) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/placed"), join(engine, "packs/placed"), { recursive: true });
  const home = temp.make("home-");
  const remote = join(home, "remote.git");
  git(home, "init", "-q", "--bare", "-b", "main", remote);
  const profile = join(home, "profile");
  git(home, "clone", "-q", remote, profile);
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["placed"], plan: "claude", settings: {}, workflows: {}, ...profileFields }, null, 2) + "\n");
  git(profile, "add", "fleet.json");
  git(profile, "commit", "-q", "-m", "Start");
  git(profile, "push", "-q", "-u", "origin", "main");
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "linux", profileDir: profile, ...machineFields }));
  const fleet = async (args: string[], host = "hub-1") => {
    const lines: string[] = [];
    const code = await main(args, { home, engineRoot: engine, platform: "linux", env: {}, print: (line) => lines.push(line), run: async () => 0, adapters: () => [filesAdapter], hostname: () => host });
    return { code, output: lines.join("\n") };
  };
  return {
    home,
    fleet,
    machineFile: () => JSON.parse(readFileSync(join(home, ".config/fleet/machine.json"), "utf8")),
    pushed: () => JSON.parse(git(home, "--git-dir", remote, "show", "main:fleet.json")),
  };
}

const hubless = "Note: Your profile lists devboxes but names no hub, so this machine leaves out 1 item that runs on the hub. Run fleet hub here on the machine that should be the hub.";

describe("fleet hub here", () => {
  test("names this machine the hub in the profile, pushes it, and the hub's items run here", async () => {
    const { fleet, machineFile, pushed } = fleetMachine({ devboxes: ["node-2"] });
    expect(await fleet(["run", "placed/placed-worker"])).toEqual({ code: 2, output: "fleet run: placed/placed-worker does not run here: your profile names no hub. Run fleet hub here on the machine that should be the hub." });
    const before = await fleet(["doctor"]);
    expect(before.output).toContain(hubless);

    const named = await fleet(["hub", "here"]);
    expect(named.code).toBe(0);
    expect(named.output).toStartWith("✓ Saved the hub, hub-1, in your profile and pushed it.");
    expect(named.output).toContain("This machine has it now. Your other machines pick it up at their next fleet update.");
    expect(pushed()).toMatchObject({ hub: "hub-1", devboxes: ["node-2"] });
    expect(machineFile()).toMatchObject({ name: "hub-1", role: "hub" });

    expect(await fleet(["run", "placed/placed-worker"])).toEqual({ code: 0, output: "placed-worker ran" });
    expect((await fleet(["doctor"])).output).not.toContain("names no hub");
    expect(await fleet(["hub", "status"])).toEqual({ code: 0, output: "This machine: hub-1, the hub.\nThe hub: hub-1." });
  });

  test("takes the SSH name the other nodes use when the host name differs", async () => {
    const { fleet, machineFile, pushed } = fleetMachine();
    expect((await fleet(["hub", "here", "my-hub"], "ip-10-0-0-1")).code).toBe(0);
    expect(pushed().hub).toBe("my-hub");
    expect(machineFile()).toMatchObject({ name: "my-hub", role: "hub" });
  });

  test("refuses a name that is not an SSH host name, and changes nothing", async () => {
    const { fleet, machineFile, pushed } = fleetMachine();
    expect(await fleet(["hub", "here", "not a host"])).toEqual({ code: 2, output: "fleet hub: usage: fleet hub here [<ssh name>], or fleet hub status" });
    expect(await fleet(["hub"])).toEqual({ code: 2, output: "fleet hub: usage: fleet hub here [<ssh name>], or fleet hub status" });
    expect(pushed().hub).toBeUndefined();
    expect(machineFile().role).toBe("linux");
  });

  test("never writes the machine file through a file planted at a temporary name", async () => {
    const { home, fleet, machineFile } = fleetMachine();
    const path = join(home, ".config/fleet/machine.json");
    writeFileSync(join(home, "victim"), "keep\n");
    for (const pid of [process.pid, process.pid + 1]) symlinkSync(join(home, "victim"), `${path}.${pid}.partial`);
    expect((await fleet(["hub", "here"])).code).toBe(0);
    expect(readFileSync(join(home, "victim"), "utf8")).toBe("keep\n");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(machineFile().role).toBe("hub");
  });
});

describe("the profile names the hub", () => {
  test("the profile wins over a saved role: a machine it does not name leaves the hub's items out, and apply saves its own role", async () => {
    const { fleet, machineFile } = fleetMachine({ hub: "hub-1" }, { role: "hub", name: "node-2" });
    expect(await fleet(["run", "placed/placed-worker"])).toEqual({ code: 2, output: "fleet run: placed/placed-worker does not run here: not on a linux" });
    expect(await fleet(["hub", "status"])).toEqual({ code: 0, output: "This machine: node-2, a linux.\nThe hub: hub-1." });
    expect((await fleet(["apply"])).code).toBe(0);
    expect(machineFile()).toMatchObject({ role: "linux", name: "node-2" });
  });

  test("the machine it names is the hub without a saved role", async () => {
    const { fleet, machineFile } = fleetMachine({ hub: "hub-1" }, { name: "hub-1" });
    expect(await fleet(["run", "placed/placed-worker"])).toEqual({ code: 0, output: "placed-worker ran" });
    expect((await fleet(["apply"])).code).toBe(0);
    expect(machineFile()).toMatchObject({ role: "hub", name: "hub-1" });
  });

  test("a profile without a hub or devboxes keeps today's placement: the only machine runs the hub's items", async () => {
    const { fleet } = fleetMachine();
    expect(await fleet(["run", "placed/placed-worker"])).toEqual({ code: 0, output: "placed-worker ran" });
    expect((await fleet(["doctor"])).output).not.toContain("names no hub");
    expect(await fleet(["hub", "status"])).toEqual({ code: 0, output: "This machine: hub-1, a linux.\nThe hub: not named. Run fleet hub here on the machine that should be the hub." });
  });

  test("apply saves the host name as this machine's name once, and keeps a saved name", async () => {
    const { fleet, machineFile } = fleetMachine();
    expect((await fleet(["apply"], "box-a")).code).toBe(0);
    expect(machineFile().name).toBe("box-a");
    expect((await fleet(["apply"], "box-b")).code).toBe(0);
    expect(machineFile().name).toBe("box-a");
  });

  test("a hub that is not an SSH host name fails to load the profile", async () => {
    const { fleet } = fleetMachine({ hub: "two words" });
    const result = await fleet(["doctor"]);
    expect(result.code).toBe(1);
    expect(result.output).toEndWith("fleet.json: hub must be the SSH name of a machine");
  });
});
