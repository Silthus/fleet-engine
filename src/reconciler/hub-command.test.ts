import { afterEach, expect, test } from "bun:test";
import { git, isolateGit, tempDirs } from "../testing/git.ts";
import { linkedFleets } from "../testing/linked.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const tricky = ["two words", "$(touch pwned); echo 'x' | cat"];

test("a command placed on the hub runs on the hub from a node, with each argument whole, and gives back the hub's exit code", async () => {
  const { hub, node } = linkedFleets(temp);
  await hub("apply");
  expect(await node("issued-admin", ...tricky)).toEqual({ code: 0, output: `yes ${JSON.stringify(tricky)}` });
  expect(await node("issued-admin", "fail")).toEqual({ code: 3, output: 'yes ["fail"]' });
  expect(await hub("issued-admin", "here")).toEqual({ code: 0, output: 'yes ["here"]' });
});

test("a machine that the profile does not name cannot run a hub command, and says where it runs", async () => {
  const { hub, other } = linkedFleets(temp);
  await hub("apply");
  const box = other({ schema: 1, role: "devbox", coder: true, name: "box-lane" });
  expect(await box("issued-admin")).toEqual({ code: 1, output: "fleet: fleet issued-admin runs on the hub, hub-1. Run it there." });
});

test("while the hub does not answer, a hub command says so and fails", async () => {
  const { node, hosts } = linkedFleets(temp);
  hosts["hub-1"] = "down";
  const ran = await node("issued-admin");
  expect(ran.code).toBe(255);
  expect(ran.output).toContain("ssh: connect to host hub-1 port 22: Connection refused");
});

test("doctor tests each served service's health at loopback and names the profile commit", async () => {
  const { hub, node, profile } = linkedFleets(temp);
  const uninstalled = await hub("doctor");
  expect(uninstalled.output).toContain("The issued service is not installed.");
  expect(uninstalled.output).not.toContain("does not answer");
  await hub("apply");
  await git(profile, "init", "-q");
  await git(profile, "add", "-A");
  await git(profile, "commit", "-qm", "profile");
  const commit = (await git(profile, "rev-parse", "--short", "HEAD")).trim();

  await node("apply");
  const down = await node("doctor");
  expect(down.code).toBe(1);
  expect(down.output).toContain(`Note: Your profile is at commit ${commit}. Every node of it should show the same commit.`);
  expect(down.output).toContain("To do: issued/issued-api does not answer at http://127.0.0.1:4600/health. Check this machine's forward to the hub hub-1, and the service on the hub.");

  const server = Bun.serve({ hostname: "127.0.0.1", port: 4600, fetch: (request) => new Response(null, { status: new URL(request.url).pathname === "/health" ? 200 : 404 }) });
  try {
    const up = await node("doctor");
    expect(up.output).not.toContain("does not answer");
    expect(up).toEqual({ code: 0, output: `Note: Your profile is at commit ${commit}. Every node of it should show the same commit.\nEverything matches your profile.` });
    expect((await hub("doctor")).output).not.toContain("does not answer");
  } finally {
    server.stop(true);
  }
});
