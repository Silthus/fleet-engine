import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { installPeerConfig, linkPeers, peerConfig, peersCommand, peersToRenew, renewPeers, unlinkPeer, type PeerLink } from "./peers.ts";
import { modeOf } from "./run-testing.ts";
import { fakeMachine, linkedHere, ok, writeHome } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const t3 = (home: string) => join(home, ".local/bin/t3");

test("unlinking a peer forgets only that peer's link and forward, never a box", () => {
  const home = temp.make("fleet-peers-");
  const box = linkedHere(home);
  writeHome(home, { ".config/fleet/peer-links/devbox-2.json": JSON.stringify({ environmentId: "env-peer", port: 21001 }) });
  const { machine, calls } = fakeMachine(home);
  expect(unlinkPeer(machine, "devbox-2")).toBe(true);
  expect(calls).toEqual([`run ${t3(home)} environment unlink env-peer`, "run systemctl --user stop fleet-peer-devbox-2-t3.service"]);
  expect(existsSync(join(home, ".config/fleet/peer-links/devbox-2.json"))).toBe(false);
  expect(existsSync(box)).toBe(true);
});

test("linking peers never targets this machine and names each peer it could not link", async () => {
  const forwarded: string[] = [];
  const { machine, lines } = fakeMachine(temp.make("fleet-peers-"), {
    run: (argv) => {
      if (argv[0] !== "systemd-run") return ok;
      forwarded.push(argv.find((arg) => arg.startsWith("--unit="))!);
      return { ...ok, code: 1, stderr: "no user bus" };
    },
  });
  expect(await linkPeers(machine)).toBe(1);
  expect(lines).toContain("not linked: my-hub, devbox-2");
  expect(forwarded).toEqual(["--unit=fleet-peer-my-hub-t3", "--unit=fleet-peer-devbox-2-t3"]);
});

test("a peer link forwards the peer's T3 over the person's own SSH config, pairs with a code made there, and records the link with mode 600", async () => {
  const home = temp.make("fleet-peers-");
  const { machine, calls } = fakeMachine(home, { onPeer: (alias, command) => (calls.push(`peer ${alias}: ${command}`), { ...ok, stdout: "pair-code\n" }) });
  expect(await linkPeers(machine, ["devbox-2"])).toBe(0);
  const forward = calls.find((call) => call.startsWith("run systemd-run"))!;
  expect(forward).toBe("run systemd-run --user --collect --unit=fleet-peer-devbox-2-t3 -p Restart=always -p RestartSec=30 ssh -NT -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:21000:127.0.0.1:3773 devbox-2");
  expect(calls).toContain("peer devbox-2: ~/.local/bin/t3 pair --ttl 5m --label devbox-1 | sed -n 's/^Token: //p'");
  expect(calls).toContain(`run ${t3(home)} environment link http://127.0.0.1:21000 --pairing-code pair-code --access full-access`);
  const record = join(home, ".config/fleet/peer-links/devbox-2.json");
  expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ environmentId: "env-box", port: 21000 });
  expect(modeOf(statSync(record))).toBe("600");
  expect(calls.join("\n")).not.toContain("coder");
});

test("linking a name that is not a peer refuses before it links anything", async () => {
  const { machine, calls } = fakeMachine(temp.make("fleet-peers-"));
  await expect(linkPeers(machine, ["devbox-2", "box-9"])).rejects.toThrow("Not a peer of devbox-1: box-9");
  expect(calls).toEqual([]);
});

const now = Date.parse("2026-10-30T00:00:00Z");
const linkTo = (label: string, expiresAt: string, status: PeerLink["status"] = "reachable"): PeerLink => ({ label, urls: [`https://${label}.relay.example.com`], status, expiresAt });

test("renewal links missing peers and links that lapse within a week, and leaves lasting links alone", () => {
  const links = [linkTo("box-1", "2026-11-27T00:00:00Z"), linkTo("box-2", "2026-11-05T00:00:00Z"), linkTo("box-3", "2026-10-29T00:00:00Z", "expired"), linkTo("mac", "2026-11-01T00:00:00Z")];
  expect(peersToRenew(["box-1", "box-2", "box-3", "box-4"], links, now)).toEqual(["box-2", "box-3", "box-4"]);
});

test("renewal keeps a peer's working address, such as a relay address, instead of moving it to a forward", async () => {
  const home = temp.make("fleet-peers-");
  const { machine, calls, lines } = fakeMachine(home, {
    now: () => now,
    peers: ["devbox-2"],
    onPeer: (alias, command) => (calls.push(`peer ${alias}: ${command}`), { ...ok, stdout: "pairing-code\n" }),
    run: (argv) => {
      calls.push(`run ${argv.join(" ")}`);
      return argv[1] === "environment" && argv[2] === "list" ? { ...ok, stdout: JSON.stringify([{ ...linkTo("devbox-2", "2026-11-02T00:00:00Z"), urls: ["https://devbox-2.relay.example.com", "http://127.0.0.1:21000"] }]) } : ok;
    },
  });
  expect(await renewPeers(machine)).toBe(0);
  expect(calls).toContain(`run ${t3(home)} environment link https://devbox-2.relay.example.com --url http://127.0.0.1:21000 --pairing-code pairing-code --access full-access`);
  expect(calls.some((call) => call.startsWith("run systemd-run"))).toBe(false);
  expect(lines).toContain("1 of 1 peer links renewed");
});

test("renewal first starts the dead forwards of recorded peer links on their recorded ports, and says when every link lasts", async () => {
  const home = temp.make("fleet-peers-");
  for (const [alias, port] of [["devbox-2", 22000], ["devbox-3", 23000]] as const) writeHome(home, { [`.config/fleet/peer-links/${alias}.json`]: JSON.stringify({ environmentId: `env-${alias}`, port }) });
  const started: string[] = [];
  const { machine, lines } = fakeMachine(home, {
    now: () => now,
    peers: ["devbox-2"],
    run: (argv) => {
      if (argv[2] === "is-active") return { ...ok, code: argv[4] === "fleet-peer-devbox-3-t3.service" ? 0 : 3 };
      if (argv[0] === "systemd-run") started.push(argv.slice(3).join(" "));
      if (argv[2] === "list") return { ...ok, stdout: JSON.stringify([linkTo("devbox-2", "2026-12-30T00:00:00Z")]) };
      return ok;
    },
  });
  expect(await renewPeers(machine)).toBe(0);
  expect(started).toHaveLength(1);
  expect(started[0]).toStartWith("--unit=fleet-peer-devbox-2-t3 ");
  expect(started[0]).toEndWith("-L 127.0.0.1:22000:127.0.0.1:3773 devbox-2");
  expect(lines).toContain("every peer link lasts more than a week");
});

test("renewal fails when T3 cannot list its links", async () => {
  const { machine } = fakeMachine(temp.make("fleet-peers-"), { run: (argv) => (argv[2] === "list" ? { ...ok, code: 1, stderr: "T3 is not running" } : ok) });
  await expect(renewPeers(machine)).rejects.toThrow("Cannot list the linked environments: T3 is not running");
});

test("the peer SSH config names each peer by its alias and leaves reaching it to the person's own SSH or Coder config", () => {
  const config = peerConfig(["my-hub", "box-1"]);
  expect(config).toBe("# Managed by Fleet peer access.\nHost my-hub box-1\n  ForwardAgent no\n  ServerAliveInterval 30\n  ServerAliveCountMax 3\n");
  expect(config).not.toMatch(/HostName|ProxyCommand|ProxyJump|IdentityFile|KnownHosts|Port /);
  expect(() => peerConfig(["box-1\n  ProxyCommand evil"])).toThrow("not an SSH name");
  expect(peerConfig([])).toBe("# Managed by Fleet peer access.\n");
});

test("peer install writes the config with mode 600, includes it first in the person's SSH config once, and keeps their own lines", async () => {
  const home = temp.make("fleet-peers-");
  writeHome(home, { ".ssh/config": "Host github.com\n  User git\n" });
  expect(await installPeerConfig(home, ["my-hub", "box-1"], true)).toEqual(["my-hub", "box-1"]);
  expect(await installPeerConfig(home, ["my-hub", "box-1"], true)).toEqual(["my-hub", "box-1"]);
  const include = `Include "${join(home, ".ssh/fleet-peers.conf")}"`;
  expect(readFileSync(join(home, ".ssh/config"), "utf8")).toBe(`${include}\nHost github.com\n  User git\n`);
  expect(readFileSync(join(home, ".ssh/fleet-peers.conf"), "utf8")).toBe(peerConfig(["my-hub", "box-1"]));
  expect([modeOf(statSync(join(home, ".ssh/config"))), modeOf(statSync(join(home, ".ssh/fleet-peers.conf")))]).toEqual(["600", "600"]);
});

test("peer plan writes nothing, and install keeps a linked SSH config and a peer file Fleet did not write", async () => {
  const home = temp.make("fleet-peers-");
  expect(await installPeerConfig(home, ["box-1"], false)).toEqual(["box-1"]);
  expect(existsSync(join(home, ".ssh"))).toBe(false);
  const personal = join(temp.make("fleet-personal-"), "config");
  writeFileSync(personal, "Host *\n");
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  symlinkSync(personal, join(home, ".ssh/config"));
  await expect(installPeerConfig(home, ["box-1"], true)).rejects.toThrow("Keep linked SSH config path");
  expect(readFileSync(personal, "utf8")).toBe("Host *\n");
  const other = temp.make("fleet-peers-");
  writeHome(other, { ".ssh/fleet-peers.conf": "Host box-1\n  HostName 10.0.0.1\n" });
  await expect(installPeerConfig(other, ["box-1"], true)).rejects.toThrow("Keep unmanaged SSH config file");
});

test("fleet peers takes plan, install, link with names, and renew, and nothing else", async () => {
  const home = temp.make("fleet-peers-");
  const { machine, lines } = fakeMachine(home);
  expect(await peersCommand(["plan"], machine)).toBe(0);
  expect(lines).toEqual(["Peer access plan: my-hub, devbox-2"]);
  expect(await peersCommand(["install"], machine)).toBe(0);
  expect(existsSync(join(home, ".ssh/fleet-peers.conf"))).toBe(true);
  for (const args of [["renew", "box-1"], ["sync"], ["plan", "extra"]]) expect(await peersCommand(args, machine)).toBe(2);
});
