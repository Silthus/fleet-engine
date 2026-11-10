import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { boxNameFor, handOver, hubForward, link, restoreForwards, startUnit, unlink } from "./links.ts";
import { readBoxSettings } from "./machine.ts";
import { boxSettings, fakeCoder, fakeMachine, linkedHere, ok, writeHome } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

test("a box name always carries the box prefix, so release can never name a devbox or the hub", () => {
  expect(boxNameFor("Lane 42")).toBe("box-lane-42");
  expect(boxNameFor("box-lane")).toBe("box-lane");
});

test("a box name is a short Coder name with no shell syntax", () => {
  expect(boxNameFor("odd name; touch INJECTED #")).toBe("box-odd-name-touch-injected");
  const long = boxNameFor("map-notes-12-someone/shape-boxes-for-every-lane");
  expect(long).toMatch(/^box-map-notes-12-someon-[0-9a-f]{4}$/);
  expect(long.length).toBeLessThanOrEqual(32);
  expect(boxNameFor("map-notes-12-someone/shape-boxes-for-every-lane-2")).not.toBe(long);
});

test("a standalone unlink keeps the hub forward, which box agents of the other machines still use", async () => {
  const { machine, calls } = fakeMachine(temp.make("fleet-box-"));
  expect(await unlink(machine, "box-lane")).toBe(true);
  expect(calls).toContain("run systemctl --user stop fleet-box-box-lane-t3.service");
  expect(calls).not.toContain("run systemctl --user stop fleet-box-box-lane-hub.service");
});

test("unlink keeps the link record when T3 cannot unlink, so a later unlink can retry", async () => {
  const home = temp.make("fleet-box-");
  const record = linkedHere(home);
  const { machine } = fakeMachine(home, { run: async (argv) => ({ ...ok, code: argv[1] === "environment" ? 1 : 0 }) });
  expect(await unlink(machine, "box-lane")).toBe(false);
  expect(existsSync(record)).toBe(true);
});

test("link forwards the box's T3 here, pairs with a one-time code made on the box, and records the link", async () => {
  const home = temp.make("fleet-box-");
  const { machine, calls } = fakeMachine(home);
  const { coder } = fakeCoder({ ssh: async (_box, command) => ({ ...ok, stdout: command.includes("t3 pair") ? "pair-code\n" : "" }) });
  expect(await link(coder, machine, "box-lane")).toBe("env-box");
  expect(calls).toContain("link http://127.0.0.1:21000 with full-access access");
  expect(calls.join("\n")).not.toContain("pair-code");
  expect(await Bun.file(join(home, ".config/fleet/boxes/box-lane.json")).json()).toEqual({ environmentId: "env-box", port: 21000 });
});

test("link gives up after a minute on the injected clock when the box's T3 never answers, and stops the forward", async () => {
  const { machine, calls } = fakeMachine(temp.make("fleet-box-"), { environmentId: async () => undefined });
  const { coder } = fakeCoder();
  await expect(link(coder, machine, "box-lane")).rejects.toThrow("within a minute");
  expect(calls.at(-1)).toBe("run systemctl --user stop fleet-box-box-lane-t3.service");
});

test("handing over sends the gateway client and its key for the store, the Claude token, and the GitHub login on stdin only, installed with umask 077", async () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/mcphub.client.json": JSON.stringify({ baseUrl: "http://127.0.0.1:3317/mcphub", token: "secretgateway" }), ".config/fleet/box-claude-token": "secret claude\n" });
  const { machine } = fakeMachine(home, { run: async (argv) => (argv[0] === "gh" ? { ...ok, stdout: "gho_secret\n" } : ok) });
  const { coder, calls } = fakeCoder();
  await handOver(coder, machine, "box-lane");
  expect(calls.map((call) => call.command).join("\n")).not.toMatch(/secretgateway|secret claude|gho_secret/);
  expect(calls.find((call) => call.stdin === "secretgateway")?.command).toContain("umask 077");
  expect(calls.find((call) => call.stdin === "secretgateway")?.command).toContain("~/.config/fleet/secrets/mcp-gateway/credential.mcp-gateway");
  expect(calls.find((call) => call.stdin?.includes("secretgateway"))?.command).toContain("~/.config/fleet/mcphub.client.json");
  expect(calls.find((call) => call.stdin === "secret claude\n")?.command).toContain("~/.config/fleet/box-claude-token");
  expect(calls.find((call) => call.stdin === "gho_secret\n")?.command).toContain("gh auth login --with-token");
});

test("handing over skips the files this machine does not have", async () => {
  const { machine, lines } = fakeMachine(temp.make("fleet-box-"), { run: async () => ({ ...ok, code: 1 }) });
  const { coder, calls } = fakeCoder();
  await handOver(coder, machine, "box-lane");
  expect(calls).toEqual([]);
  expect(lines).toEqual(["skip ~/.config/fleet/mcphub.client.json: this machine has none", "skip ~/.config/fleet/box-claude-token: this machine has none", "skip the GitHub CLI login: gh is not logged in here"]);
});

test("a gh login file that holds the token goes over stdin with mode 600, with no login that needs GitHub's API", async () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/gh/hosts.yml": "github.com:\n    oauth_token: gho_secret\n" });
  const { machine } = fakeMachine(home);
  const { coder, calls } = fakeCoder();
  await handOver(coder, machine, "box-lane");
  expect(calls.map((call) => call.command).join("\n")).not.toContain("gho_secret");
  expect(calls.find((call) => call.stdin?.includes("gho_secret"))?.command).toContain("umask 077");
  expect(calls.some((call) => call.command.includes("gh auth login"))).toBe(false);
});

test("restore starts the dead forwards of recorded box links on their recorded ports and leaves running ones alone", async () => {
  const home = temp.make("fleet-box-");
  for (const [name, port] of [["box-lane", 21000], ["box-other", 22000], ["box-up", 23000]] as const) {
    writeHome(home, { [`.config/fleet/boxes/${name}.json`]: JSON.stringify({ environmentId: `env-${name}`, port }) });
  }
  const started: string[] = [];
  const { machine } = fakeMachine(home, {
    run: async (argv) => {
      if (argv[2] === "is-active") return { ...ok, code: argv[4] === "fleet-box-box-up-t3.service" ? 0 : 3 };
      if (argv[0] === "systemd-run") started.push(`${argv[3]} ${argv.at(-1)}`);
      return ok;
    },
  });
  expect(await restoreForwards({ binary: async () => "coder", env: { CODER_SESSION_TOKEN: "secret" } }, machine)).toBe(0);
  expect(started).toHaveLength(2);
  expect(started[0]).toStartWith("--unit=fleet-box-box-lane-t3 ");
  expect(started[0]).toContain("'port-forward' '--disable-autostart' 'box-lane' '--tcp' '21000:3773'");
  expect(started[0]).toContain(`. '${join(home, ".config/fleet/box-coder.env")}' && export CODER_SESSION_TOKEN CODER_URL && exec`);
  expect(started.join("\n")).not.toContain("secret");
  expect(started[1]).toStartWith("--unit=fleet-box-box-other-t3 ");
});

test("restore does nothing when every recorded forward runs, or when there is no link", async () => {
  const home = temp.make("fleet-box-");
  const { machine, calls } = fakeMachine(home, { run: async (argv) => (calls.push(argv.join(" ")), ok) });
  expect(await restoreForwards({ binary: async () => { throw new Error("no coder needed"); }, env: {} }, machine)).toBe(0);
  expect(calls).toEqual([]);
  writeHome(home, { ".config/fleet/boxes/box-lane.json": JSON.stringify({ environmentId: "env-1", port: 21000 }) });
  expect(await restoreForwards({ binary: async () => { throw new Error("no coder needed"); }, env: {} }, machine)).toBe(0);
  expect(calls).toEqual(["systemctl --user is-active --quiet fleet-box-box-lane-t3.service"]);
});

test("a forward service gets the Coder session the commands resolved, from the environment too, through a private file and never its command line", async () => {
  const home = temp.make("fleet-box-");
  const bin = temp.make("fleet-bin-");
  const seen = join(bin, "seen");
  writeFileSync(join(bin, "coder"), `#!/bin/sh\nprintf '%s %s' "$CODER_SESSION_TOKEN" "$CODER_URL" > "${seen}"\n`);
  chmodSync(join(bin, "coder"), 0o755);
  const started: string[][] = [];
  const { machine } = fakeMachine(home, { run: async (argv) => (started.push(argv), ok) });
  const coder = { binary: async () => join(bin, "coder"), env: { CODER_SESSION_TOKEN: "env-secret", CODER_URL: "https://env.example.com" } };
  await startUnit(coder, machine, "fleet-box-box-lane-t3", ["port-forward", "box-lane"]);
  const service = started.find((argv) => argv[0] === "systemd-run")!;
  expect(service.join(" ")).not.toContain("env-secret");
  expect(statSync(join(home, ".config/fleet/box-coder.env")).mode & 0o777).toBe(0o600);
  const ran = Bun.spawnSync([...service.slice(service.indexOf("sh"))], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(ran.exitCode).toBe(0);
  expect(readFileSync(seen, "utf8")).toBe("env-secret https://env.example.com");
});

const withSettings = (extra: Record<string, unknown>) => readBoxSettings({ FLEET_SETTINGS: JSON.stringify({ ...boxSettings, ...extra }) });
const gatewayRoute = "'-R' '3317:127.0.0.1:3317'";

test("the box gets the hub's gateway key at the tunnel address that grant gives a devbox, its own loopback, which the hub forward carries to the hub's gateway, also when the hub has an HTTPS host", async () => {
  for (const extra of [{ "hub.httpsHost": "hub.internal.example.com" }, {}]) {
    const home = temp.make("fleet-box-");
    writeHome(home, { ".config/fleet/mcphub.client.json": JSON.stringify({ baseUrl: "http://127.0.0.1:3317/mcphub", token: "hubkey" }) });
    const { machine } = fakeMachine(home, { settings: withSettings(extra), run: async () => ({ ...ok, code: 1 }) });
    const { coder, calls } = fakeCoder();
    await handOver(coder, machine, "box-lane");
    const sent = calls.find((call) => call.command.includes("~/.config/fleet/mcphub.client.json"));
    expect(JSON.parse(sent?.stdin ?? "{}")).toEqual({ baseUrl: "http://127.0.0.1:3317/mcphub", token: "hubkey" });
    const forward = hubForward(machine, "box-lane").map((arg) => `'${arg}'`).join(" ");
    expect(forward).toContain("'-R' '60001:127.0.0.1:60001'");
    expect(forward).toContain(gatewayRoute);
  }
});

test("round 6, finding 1: the hub's restore brings back the hub forward, with its gateway route, of each box a lane holds, and never of a pooled box or on a devbox", async () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/box-pool.json": JSON.stringify({ free: ["box-pooled"], boxes: { "box-lane": { id: "ws-box-lane", claim: "c-1" }, "box-pooled": { id: "ws-box-pooled" } } }) });
  for (const isHub of [true, false]) {
    const started: string[] = [];
    const { machine } = fakeMachine(home, {
      isHub,
      run: async (argv) => {
        if (argv[2] === "is-active") return { ...ok, code: 3 };
        if (argv[0] === "systemd-run") started.push(`${argv[3]} ${argv.at(-1)}`);
        return ok;
      },
    });
    expect(await restoreForwards({ binary: async () => "coder", env: {} }, machine)).toBe(0);
    expect(started.map((line) => line.split(" ")[0])).toEqual(isHub ? ["--unit=fleet-box-box-lane-hub"] : []);
    if (isHub) expect(started[0]).toContain(gatewayRoute);
  }
});

test("round 6, finding 1: a hub gateway file that is not a key from the hub is not handed over, and the handover says why", async () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/mcphub.client.json": JSON.stringify({ baseUrl: "http://elsewhere.example.com/mcphub", token: "hubkey" }) });
  const { machine, lines } = fakeMachine(home, { run: async () => ({ ...ok, code: 1 }) });
  const { coder, calls } = fakeCoder();
  expect(await handOver(coder, machine, "box-lane")).toBe(false);
  expect(calls.some((call) => call.command.includes("mcphub.client.json"))).toBe(false);
  expect(lines[0]).toStartWith("skip the MCP gateway key: ~/.config/fleet/mcphub.client.json is not a key from your hub.");
});
