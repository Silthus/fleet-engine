import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { linkedFleets } from "../testing/linked.ts";

isolateGit();
const temp = tempDirs();
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  temp.cleanup();
});

function healthServer() {
  const state = { status: 503 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => new Response(null, { status: new URL(request.url).pathname === "/health" ? state.status : 404 }) });
  servers.push(server);
  return { port: server.port!, state };
}

async function committed(profile: string) {
  await spawnGit(profile, "init", "-q");
  await spawnGit(profile, "add", "-A");
  await spawnGit(profile, "commit", "-qm", "profile");
  return spawnGit(profile, "rev-parse", "--short", "HEAD");
}

test("a command placed on the hub runs on the hub when a node types it", async () => {
  const { hub, node } = linkedFleets(temp);
  await hub("apply");
  expect(await node("issued-admin", "here")).toEqual({ code: 0, output: 'yes ["here"]' });
});

test("a hub command from a node keeps each argument whole", async () => {
  const { hub, node } = linkedFleets(temp);
  await hub("apply");
  const tricky = ["two words", "$(touch pwned); echo 'x' | cat", "=printf"];
  expect(await node("issued-admin", ...tricky)).toEqual({ code: 0, output: `yes ${JSON.stringify(tricky)}` });
});

test("a hub command from a node gives back the hub's exit code", async () => {
  const { hub, node } = linkedFleets(temp);
  await hub("apply");
  expect(await node("issued-admin", "fail")).toEqual({ code: 3, output: 'yes ["fail"]' });
});

test("the hub runs its own hub command", async () => {
  const { hub } = linkedFleets(temp);
  await hub("apply");
  expect(await hub("issued-admin", "here")).toEqual({ code: 0, output: 'yes ["here"]' });
});

test("a machine that the profile does not name cannot run a hub command, and says where it runs", async () => {
  const { other } = linkedFleets(temp);
  const box = other({ schema: 1, role: "devbox", coder: true, name: "box-lane" });
  expect(await box("issued-admin")).toEqual({ code: 1, output: "fleet: fleet issued-admin runs on the hub, hub-1. Run it there." });
});

test("while the hub does not answer, a hub command says so and exits 1, so a caller can fall back", async () => {
  const { node, hosts } = linkedFleets(temp);
  hosts["hub-1"] = "down";
  expect(await node("issued-admin")).toEqual({ code: 1, output: "ssh: connect to host hub-1 port 22: Connection refused\nfleet issued-admin: ssh to the hub hub-1 exited 255. Either ssh could not reach the hub, or the command failed there with 255." });
});

test("a Mac on a profile with a hub runs a hub command on the hub", async () => {
  const { hub, mac } = linkedFleets(temp);
  await hub("apply");
  expect(await mac()("issued-admin", "here")).toEqual({ code: 0, output: 'yes ["here"]' });
});

test("doctor names the profile commit", async () => {
  const { node, profile } = linkedFleets(temp);
  const commit = await committed(profile);
  expect((await node("doctor")).output).toContain(`Note: Your profile is at commit ${commit}. Every node of it should show the same commit.`);
});

test("on a node, doctor names a served service that does not answer at loopback and fails", async () => {
  const { port } = healthServer();
  const { hub, node } = linkedFleets(temp, port);
  await hub("apply");
  await node("apply");
  const doctor = await node("doctor");
  expect(doctor.code).toBe(1);
  expect(doctor.output).toContain(`To do: issued/issued-api does not answer at http://127.0.0.1:${port}/health. Check this machine's forward to the hub hub-1, and the service on the hub.`);
});

test("on a node, doctor passes when each served service answers at loopback", async () => {
  const { port, state } = healthServer();
  state.status = 200;
  const { hub, node, profile } = linkedFleets(temp, port);
  await hub("apply");
  await node("apply");
  const commit = await committed(profile);
  expect(await node("doctor")).toEqual({ code: 0, output: `Note: Your profile is at commit ${commit}. Every node of it should show the same commit.\nEverything matches your profile.` });
});

test("on the hub, doctor names a served service that does not answer", async () => {
  const { port } = healthServer();
  const { hub } = linkedFleets(temp, port);
  await hub("apply");
  expect((await hub("doctor")).output).toContain(`To do: issued/issued-api does not answer at http://127.0.0.1:${port}/health. Check the service on this machine.`);
});

test("on the hub, doctor names only the install check of a service that is not installed yet", async () => {
  const { port } = healthServer();
  const { hub } = linkedFleets(temp, port);
  const doctor = await hub("doctor");
  expect(doctor.output).toContain("The issued service is not installed.");
  expect(doctor.output).not.toContain("does not answer");
});

test("a solo machine's doctor tests no served service, because it has no node to drift from", async () => {
  const { port } = healthServer();
  const { other, profile } = linkedFleets(temp, port);
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["issued"], plan: "claude", settings: {}, workflows: {} }));
  const solo = other({ schema: 1, role: "linux", name: "solo-1" });
  await solo("apply");
  expect((await solo("doctor")).output).not.toContain("does not answer");
});
