import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { fakeRun, modeOf, roleHome } from "./run-testing.ts";
import { hostsWith, sshTunnels, tunnelTargets, tunnelUnit, type TunnelMachine } from "./tunnels.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const host = "hub.internal.example.com";

function machine(role: string, fields: Partial<TunnelMachine> = {}) {
  const home = fields.home ?? roleHome(temp.make("fleet-tunnels-"), role);
  const hosts = join(temp.make("fleet-etc-"), "hosts");
  writeFileSync(hosts, "127.0.0.1 localhost\n10.0.0.1 unrelated.example\n");
  const fake = fakeRun();
  const printed: string[] = [];
  const deps: TunnelMachine = { home, devboxes: ["devbox-1", "devbox-2"], relayPort: 60002, httpsHost: host, hosts, run: fake.run, print: (line) => printed.push(line), ...fields };
  return { deps, home, hosts, calls: fake.calls, inputs: fake.inputs, printed };
}

const unitPath = (home: string, alias: string) => join(home, `.config/systemd/user/fleet-ssh-${alias}.service`);

test("a hub tunnel forwards only the relay port to the devbox's loopback, and never a proxy port or a catalog port, which the devbox's own forward carries", () => {
  const unit = tunnelUnit("devbox-1", 60002);
  expect(unit).toContain("-R 127.0.0.1:60002:127.0.0.1:60002");
  expect(unit).toMatch(/ devbox-1\n/);
  for (const option of ["ExitOnForwardFailure=yes", "ForwardAgent=no", "BatchMode=yes", "Restart=always", "Environment=CODER_SSH_DISABLE_AUTOSTART=true"]) expect(unit).toContain(option);
  expect(unit).not.toMatch(/3317|8317|60001| -L |:22\b/);
  expect([...unit.matchAll(/ -R /g)]).toHaveLength(1);
});

test("a tunnel refuses an alias that could break its unit, and a relay port that is the gateway's or a system port", () => {
  expect(() => tunnelUnit("devbox-1\nExecStart=bad", 60002)).toThrow("not an SSH name");
  expect(() => tunnelUnit("devbox-1", 3317)).toThrow("hub.relayPort");
  expect(() => tunnelUnit("devbox-1", 80)).toThrow("hub.relayPort");
});

test("the hub opens a tunnel to every devbox in the merged list, but not to itself", () => {
  expect(tunnelTargets("my-hub", ["devbox-1", "my-hub", "devbox-2", "devbox-1", "hub-host"], "hub-host")).toEqual(["devbox-1", "devbox-2"]);
});

test("install on the hub writes one unit per devbox with mode 600, restarts the changed ones, and the doctor checks each", async () => {
  const { deps, home, calls, printed } = machine("hub");
  expect(await sshTunnels("install", deps)).toBe(0);
  for (const alias of ["devbox-1", "devbox-2"]) {
    expect(readFileSync(unitPath(home, alias), "utf8")).toBe(tunnelUnit(alias, 60002));
    expect(modeOf(statSync(unitPath(home, alias)))).toBe("600");
    expect(calls).toContain(`systemctl --user restart fleet-ssh-${alias}.service`);
    expect(calls).toContain(`systemctl --user enable --now fleet-ssh-${alias}.service`);
    expect(calls).toContain(`systemctl --user is-active --quiet fleet-ssh-${alias}.service`);
  }
  expect(printed).toEqual(["devbox-1: SSH tunnel active", "devbox-2: SSH tunnel active"]);
  const again = machine("hub", { home });
  await sshTunnels("install", again.deps);
  expect(again.calls.some((call) => call.includes("restart"))).toBe(false);
});

test("the doctor fails when a tunnel is not running", async () => {
  const installed = machine("hub");
  await sshTunnels("install", installed.deps);
  const { deps } = machine("hub", { home: installed.home, run: fakeRun((command) => (command.includes("is-active") ? { code: 3 } : undefined)).run });
  await expect(sshTunnels("doctor", deps)).rejects.toThrow("systemctl --user is-active --quiet fleet-ssh-devbox-1.service failed");
});

test("plan writes nothing and runs nothing", async () => {
  const { deps, home, calls, printed } = machine("hub");
  expect(await sshTunnels("plan", deps)).toBe(0);
  expect(existsSync(join(home, ".config/systemd"))).toBe(false);
  expect(calls).toEqual([]);
  expect(printed).toEqual(["devbox-1: SSH tunnel planned", "devbox-2: SSH tunnel planned"]);
});

test("install keeps a dangling linked unit and a unit Fleet did not write", async () => {
  const home = roleHome(temp.make("fleet-tunnels-"), "hub");
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  const target = join(home, "unmanaged");
  symlinkSync(target, unitPath(home, "devbox-1"));
  await expect(sshTunnels("install", machine("hub", { home }).deps)).rejects.toThrow("Keep linked tunnel path");
  expect(existsSync(target)).toBe(false);
  const other = roleHome(temp.make("fleet-tunnels-"), "hub");
  mkdirSync(join(other, ".config/systemd/user"), { recursive: true });
  writeFileSync(unitPath(other, "devbox-2"), "[Service]\nExecStart=/bin/true\n");
  await expect(sshTunnels("install", machine("hub", { home: other }).deps)).rejects.toThrow("Keep unmanaged tunnel file");
  expect(readFileSync(unitPath(other, "devbox-2"), "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
});

test("on a devbox, install maps hub.httpsHost to loopback in the hosts file once, through sudo, and keeps every other entry", async () => {
  const { deps, hosts, calls, inputs } = machine("devbox");
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(calls).toEqual([`sudo -n tee ${hosts}`]);
  expect(inputs[0]).toBe(`127.0.0.1 localhost\n10.0.0.1 unrelated.example\n127.0.0.1 ${host} # fleet-hub-tunnel\n`);
  writeFileSync(hosts, inputs[0]!);
  const again = machine("devbox", { home: deps.home, hosts });
  expect(await sshTunnels("install", again.deps)).toBe(0);
  expect(again.calls).toEqual([]);
  expect(await sshTunnels("doctor", again.deps)).toBe(0);
});

test("the hosts entry replaces its own old line, keeps an entry the person wrote, and the devbox doctor fails until it is there", async () => {
  expect(hostsWith("127.0.0.1 localhost\n127.0.0.1 old.example # fleet-hub-tunnel\n", host)).toBe(`127.0.0.1 localhost\n127.0.0.1 ${host} # fleet-hub-tunnel\n`);
  expect(() => hostsWith(`10.1.2.3 ${host}\n`, host)).toThrow("Keep unmanaged hosts entry");
  const { deps } = machine("devbox");
  await expect(sshTunnels("doctor", deps)).rejects.toThrow(`does not map ${host}`);
});

test("on a devbox, a symlinked hosts file stays, and an empty hub.httpsHost needs no entry", async () => {
  const { deps, hosts } = machine("devbox");
  const linked = join(temp.make("fleet-etc-"), "hosts");
  symlinkSync(hosts, linked);
  await expect(sshTunnels("install", { ...deps, hosts: linked })).rejects.toThrow("Keep linked hosts file");
  const off = machine("devbox", { httpsHost: undefined });
  expect(await sshTunnels("install", off.deps)).toBe(0);
  expect(off.calls).toEqual([]);
  expect(off.printed).toEqual(["No hosts entry needed: hub.httpsHost is empty."]);
});

test("ssh-tunnels refuses on a Mac or a plain Linux machine and names the Mac command", async () => {
  await expect(sshTunnels("install", machine("mac").deps)).rejects.toThrow("fleet hub-tunnel");
});

test("install on the hub disables and deletes the tunnel unit of a devbox that left the list, and keeps units Fleet did not write", async () => {
  const home = roleHome(temp.make("fleet-tunnels-"), "hub");
  const elsewhere = join(temp.make("fleet-elsewhere-"), "unit");
  writeFileSync(elsewhere, tunnelUnit("devbox-7", 60002));
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(unitPath(home, "devbox-9"), tunnelUnit("devbox-9", 60002));
  writeFileSync(unitPath(home, "devbox-8"), "[Service]\nExecStart=/bin/true\n");
  symlinkSync(elsewhere, unitPath(home, "devbox-7"));
  writeFileSync(join(home, ".config/systemd/user/other.service"), tunnelUnit("devbox-6", 60002));
  const { deps, calls } = machine("hub", { home });
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(existsSync(unitPath(home, "devbox-9"))).toBe(false);
  expect(calls).toContain("systemctl --user disable --now fleet-ssh-devbox-9.service");
  expect(calls.indexOf("systemctl --user disable --now fleet-ssh-devbox-9.service")).toBeLessThan(calls.indexOf("systemctl --user daemon-reload"));
  expect(readFileSync(unitPath(home, "devbox-8"), "utf8")).toBe("[Service]\nExecStart=/bin/true\n");
  expect(readFileSync(elsewhere, "utf8")).toBe(tunnelUnit("devbox-7", 60002));
  expect(existsSync(join(home, ".config/systemd/user/other.service"))).toBe(true);
  expect(calls.filter((call) => call.includes("disable"))).toEqual(["systemctl --user disable --now fleet-ssh-devbox-9.service"]);
  const plan = machine("hub", { home: roleHome(temp.make("fleet-tunnels-"), "hub") });
  mkdirSync(join(plan.home, ".config/systemd/user"), { recursive: true });
  writeFileSync(unitPath(plan.home, "devbox-9"), tunnelUnit("devbox-9", 60002));
  await sshTunnels("plan", plan.deps);
  expect(existsSync(unitPath(plan.home, "devbox-9"))).toBe(true);
  expect(plan.calls).toEqual([]);
});

test("the hub doctor fails when a wanted unit is missing or differs from what install writes now, or a stale Fleet unit remains", async () => {
  const { deps, home } = machine("hub");
  await sshTunnels("install", deps);
  expect(await sshTunnels("doctor", machine("hub", { home }).deps)).toBe(0);
  await expect(sshTunnels("doctor", machine("hub", { home, relayPort: 60003 }).deps)).rejects.toThrow(`${unitPath(home, "devbox-1")}`);
  await expect(sshTunnels("doctor", machine("hub", { home, devboxes: ["devbox-1", "devbox-2", "devbox-3"] }).deps)).rejects.toThrow(`${unitPath(home, "devbox-3")}`);
  await expect(sshTunnels("doctor", machine("hub", { home, devboxes: ["devbox-1"] }).deps)).rejects.toThrow(`${unitPath(home, "devbox-2")}`);
  await expect(sshTunnels("doctor", machine("hub", { home, devboxes: ["devbox-1"] }).deps)).rejects.toThrow("Run fleet ssh-tunnels install");
  expect(readFileSync(unitPath(home, "devbox-2"), "utf8")).toBe(tunnelUnit("devbox-2", 60002));
});

test("the hub opens no SSH tunnel to a box in the devbox list, says so once, and removes the tunnel an earlier install wrote for it", async () => {
  const home = roleHome(temp.make("fleet-tunnels-"), "hub");
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  writeFileSync(unitPath(home, "box-lane"), tunnelUnit("box-lane", 60002));
  const { deps, calls, printed } = machine("hub", { home, devboxes: ["devbox-1", "box-lane"] });
  expect(await sshTunnels("install", deps)).toBe(0);
  expect(existsSync(unitPath(home, "box-lane"))).toBe(false);
  expect(calls).toContain("systemctl --user disable --now fleet-ssh-box-lane.service");
  expect(calls.filter((call) => call.includes("box-lane"))).toEqual(["systemctl --user disable --now fleet-ssh-box-lane.service"]);
  expect(printed).toEqual(["box-lane: skipped: a box gets the gateway and relay ports from its own box forward", "devbox-1: SSH tunnel active"]);
  expect(await sshTunnels("doctor", machine("hub", { home, devboxes: ["devbox-1", "box-lane"] }).deps)).toBe(0);
});
