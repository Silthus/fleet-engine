import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobsAdapter } from "../adapters/jobs/adapter.ts";
import { main, type CliOptions } from "../cli.ts";
import type { MachineFile } from "../pack/types.ts";
import { tempDirs } from "../testing/git.ts";
import { fakeSystemd } from "../testing/systemd.ts";
import { filesAdapter } from "./apply.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const repoRoot = join(import.meta.dir, "../..");
const hub: MachineFile = { schema: 1, role: "linux", name: "hub-1" };
const node: MachineFile = { schema: 1, role: "devbox", coder: true, name: "node-2" };

function machine(saved: MachineFile, extra: Record<string, string> = {}) {
  const engine = temp.make("engine-");
  cpSync(join(repoRoot, "packs/base"), join(engine, "packs/base"), { recursive: true });
  cpSync(join(import.meta.dir, "fixtures/served"), join(engine, "packs/served"), { recursive: true });
  for (const [name, source] of Object.entries(extra)) {
    mkdirSync(join(engine, "packs", name), { recursive: true });
    writeFileSync(join(engine, "packs", name, "pack.ts"), source);
  }
  const home = temp.make("home-");
  const profile = temp.make("profile-");
  const writeProfile = (fields: { packs?: string[]; workflows?: Record<string, boolean>; devboxes?: string[] } = {}) =>
    writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: fields.packs ?? ["served", ...Object.keys(extra)], plan: "claude", settings: {}, workflows: fields.workflows ?? {}, hub: "hub-1", devboxes: fields.devboxes ?? ["node-2"] }));
  writeProfile();
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ ...saved, profileDir: profile }));
  const systemd = fakeSystemd();
  const unit = join(home, ".config/systemd/user/fleet-hub-forward.service");
  const log = join(home, ".local/state/fleet/jobs/hub-forward.log");
  let started: string[] | undefined;
  const run: typeof systemd.run = async (command, options) => {
    const answer = await systemd.run(command, options);
    if (command.join(" ") !== "systemctl --user restart fleet-hub-forward.service") return answer;
    const execStart = readFileSync(unit, "utf8").match(/^ExecStart=(.+)$/m)![1]!;
    writeFileSync(log, "");
    Bun.spawnSync(["/bin/sh", "-c", execStart], { env: { HOME: home } });
    started = readFileSync(log, "utf8").trimEnd().split("\n");
    return answer;
  };
  let lines: string[] = [];
  const options: CliOptions = {
    home,
    engineRoot: engine,
    platform: "linux",
    env: {},
    print: (line) => lines.push(line),
    hostname: () => saved.name!,
    run: async (command) => (command[0] === "/bin/sh" && command[1] === join(engine, "fleet") ? main(command.slice(2), { ...options, print: () => {} }) : 0),
    adapters: () => [filesAdapter, jobsAdapter({ run, engineRoot: engine })],
  };
  const apply = async () => {
    lines = [];
    return { code: await main(["apply"], options), output: lines.join("\n") };
  };
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/ssh"), `#!/bin/sh\nprintf '%s\\n' "$@"\n`, { mode: 0o755 });
  const forward = () => {
    const state = systemd.service(home, "hub-forward");
    if (state !== "running" || started === undefined) return state;
    const words = started;
    const ports = words.flatMap((word, index) => (words[index - 1] === "-L" ? [word] : []));
    return { to: words.at(-1), batch: words.includes("BatchMode=yes"), ports };
  };
  return { apply, forward, writeProfile };
}

test("a node's apply starts one forward to the hub with the catalog's ports", async () => {
  const fleet = machine(node);
  expect((await fleet.apply()).code).toBe(0);
  expect(fleet.forward()).toEqual({ to: "hub-1", batch: true, ports: ["127.0.0.1:4555:127.0.0.1:4555"] });
});

test("a catalog change restarts the forward with the new ports", async () => {
  const fleet = machine(node);
  await fleet.apply();
  fleet.writeProfile({ workflows: { "served-extra": true } });
  expect((await fleet.apply()).code).toBe(0);
  expect(fleet.forward()).toEqual({ to: "hub-1", batch: true, ports: ["127.0.0.1:4555:127.0.0.1:4555", "127.0.0.1:4556:127.0.0.1:4556"] });
});

test("an empty catalog removes the forward", async () => {
  const fleet = machine(node);
  await fleet.apply();
  fleet.writeProfile({ packs: [] });
  expect((await fleet.apply()).code).toBe(0);
  expect(fleet.forward()).toBe("gone");
});

test("the hub renders no forward", async () => {
  const onHub = machine(hub);
  expect((await onHub.apply()).code).toBe(0);
  expect(onHub.forward()).toBe("gone");
});

test("a machine that the profile does not name renders no forward", async () => {
  const stranger = machine({ schema: 1, role: "devbox", coder: true, name: "devbox-9" });
  expect((await stranger.apply()).code).toBe(0);
  expect(stranger.forward()).toBe("gone");
});

test("a box renders no forward even when the profile names it, because its box forward carries the hub's ports", async () => {
  const box = machine({ schema: 1, role: "devbox", coder: true, name: "box-lane" });
  box.writeProfile({ devboxes: ["node-2", "box-lane"] });
  expect((await box.apply()).code).toBe(0);
  expect(box.forward()).toBe("gone");
});

test("a pack cannot take the forward's job id", async () => {
  const fleet = machine(node, { taker: `export default { sdk: 1, name: "taker", summary: "A test pack.", register(fleet) { fleet.service({ id: "hub-forward", run: async () => {} }); } };\n` });
  const applied = await fleet.apply();
  expect(applied.code).toBe(1);
  expect(applied.output).toContain("job hub-forward is reserved by the engine");
});
