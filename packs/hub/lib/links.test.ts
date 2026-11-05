import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { boxNameFor, handOver, link, restoreForwards, unlink } from "./links.ts";
import { fakeCoder, fakeMachine, linkedHere, ok, writeHome } from "./testing.ts";

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

test("a standalone unlink keeps the hub forward, which box agents of the other machines still use", () => {
  const { machine, calls } = fakeMachine(temp.make("fleet-box-"));
  expect(unlink(machine, "box-lane")).toBe(true);
  expect(calls).toContain("run systemctl --user stop fleet-box-box-lane-t3.service");
  expect(calls).not.toContain("run systemctl --user stop fleet-box-box-lane-hub.service");
});

test("unlink keeps the link record when T3 cannot unlink, so a later unlink can retry", () => {
  const home = temp.make("fleet-box-");
  const record = linkedHere(home);
  const { machine } = fakeMachine(home, { run: (argv) => ({ ...ok, code: argv[1] === "environment" ? 1 : 0 }) });
  expect(unlink(machine, "box-lane")).toBe(false);
  expect(existsSync(record)).toBe(true);
});

test("link forwards the box's T3 here, pairs with a one-time code made on the box, and records the link", async () => {
  const home = temp.make("fleet-box-");
  const { machine, calls } = fakeMachine(home);
  const { coder } = fakeCoder({ ssh: (_box, command) => ({ ...ok, stdout: command.includes("t3 pair") ? "pair-code\n" : "" }) });
  expect(await link(coder, machine, "box-lane")).toBe("env-box");
  expect(calls).toContain(`run ${join(home, ".local/bin/t3")} environment link http://127.0.0.1:21000 --pairing-code pair-code --access full-access`);
  expect(await Bun.file(join(home, ".config/fleet/boxes/box-lane.json")).json()).toEqual({ environmentId: "env-box", port: 21000 });
});

test("link gives up after a minute on the injected clock when the box's T3 never answers, and stops the forward", async () => {
  const { machine, calls } = fakeMachine(temp.make("fleet-box-"), { environmentId: async () => undefined });
  const { coder } = fakeCoder();
  await expect(link(coder, machine, "box-lane")).rejects.toThrow("within a minute");
  expect(calls.at(-1)).toBe("run systemctl --user stop fleet-box-box-lane-t3.service");
});

test("handing over sends the gateway client, the Claude token, and the GitHub login on stdin only, installed with umask 077", () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/fleet/mcphub.client.json": "secret gateway\n", ".config/fleet/box-claude-token": "secret claude\n" });
  const { machine } = fakeMachine(home, { run: (argv) => (argv[0] === "gh" ? { ...ok, stdout: "gho_secret\n" } : ok) });
  const { coder, calls } = fakeCoder();
  handOver(coder, machine, "box-lane");
  expect(calls.map((call) => call.command).join("\n")).not.toMatch(/secret/);
  expect(calls.find((call) => call.stdin === "secret gateway\n")?.command).toContain("umask 077");
  expect(calls.find((call) => call.stdin === "secret gateway\n")?.command).toContain("~/.config/fleet/mcphub.client.json");
  expect(calls.find((call) => call.stdin === "secret claude\n")?.command).toContain("~/.config/fleet/box-claude-token");
  expect(calls.find((call) => call.stdin === "gho_secret\n")?.command).toContain("gh auth login --with-token");
});

test("handing over skips the files this machine does not have", () => {
  const { machine, lines } = fakeMachine(temp.make("fleet-box-"), { run: () => ({ ...ok, code: 1 }) });
  const { coder, calls } = fakeCoder();
  handOver(coder, machine, "box-lane");
  expect(calls).toEqual([]);
  expect(lines).toEqual(["skip ~/.config/fleet/mcphub.client.json: this machine has none", "skip ~/.config/fleet/box-claude-token: this machine has none", "skip the GitHub CLI login: gh is not logged in here"]);
});

test("a gh login file that holds the token goes over stdin with mode 600, with no login that needs GitHub's API", () => {
  const home = temp.make("fleet-box-");
  writeHome(home, { ".config/gh/hosts.yml": "github.com:\n    oauth_token: gho_secret\n" });
  const { machine } = fakeMachine(home);
  const { coder, calls } = fakeCoder();
  handOver(coder, machine, "box-lane");
  expect(calls.map((call) => call.command).join("\n")).not.toContain("gho_secret");
  expect(calls.find((call) => call.stdin?.includes("gho_secret"))?.command).toContain("umask 077");
  expect(calls.some((call) => call.command.includes("gh auth login"))).toBe(false);
});

test("restore starts the dead forwards of recorded box links on their recorded ports and leaves running ones alone", () => {
  const home = temp.make("fleet-box-");
  for (const [name, port] of [["box-lane", 21000], ["box-other", 22000], ["box-up", 23000]] as const) {
    writeHome(home, { [`.config/fleet/boxes/${name}.json`]: JSON.stringify({ environmentId: `env-${name}`, port }) });
  }
  const started: string[] = [];
  const { machine } = fakeMachine(home, {
    run: (argv) => {
      if (argv[2] === "is-active") return { ...ok, code: argv[4] === "fleet-box-box-up-t3.service" ? 0 : 3 };
      if (argv[0] === "systemd-run") started.push(`${argv[3]} ${argv.at(-1)}`);
      return ok;
    },
  });
  expect(restoreForwards({ binary: "coder" }, machine)).toBe(0);
  expect(started).toHaveLength(2);
  expect(started[0]).toStartWith("--unit=fleet-box-box-lane-t3 ");
  expect(started[0]).toContain("'port-forward' '--disable-autostart' 'box-lane' '--tcp' '21000:3773'");
  expect(started[0]).toContain('CODER_SESSION_TOKEN="$(cat ~/.config/coderv2/session)"');
  expect(started[1]).toStartWith("--unit=fleet-box-box-other-t3 ");
});

test("restore does nothing when every recorded forward runs, or when there is no link", () => {
  const home = temp.make("fleet-box-");
  const { machine, calls } = fakeMachine(home, { run: (argv) => (calls.push(argv.join(" ")), ok) });
  expect(restoreForwards({ get binary(): string { throw new Error("no coder needed"); } }, machine)).toBe(0);
  expect(calls).toEqual([]);
  writeHome(home, { ".config/fleet/boxes/box-lane.json": JSON.stringify({ environmentId: "env-1", port: 21000 }) });
  expect(restoreForwards({ get binary(): string { throw new Error("no coder needed"); } }, machine)).toBe(0);
  expect(calls).toEqual(["systemctl --user is-active --quiet fleet-box-box-lane-t3.service"]);
});
