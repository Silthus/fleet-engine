import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { buildImage, install, mcphubImage } from "./install.ts";
import { fakeHub, fakeMcpHub, fakeRun, mcphubFetch, writeMachineFile, type RunCall } from "./testing.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function hubHome(role = "hub") {
  const home = temp.make("fleet-mcphub-install-");
  writeMachineFile(home, role);
  return home;
}

function docker(container?: Record<string, unknown>) {
  return (call: RunCall) => {
    const [tool, noun, verb, name] = call.command;
    if (tool !== "docker") return {};
    if (noun === "image" && verb === "inspect") return { stdout: JSON.stringify([{ Id: `sha256:${name}` }]) };
    if (noun === "container" && verb === "inspect") return container ? { stdout: JSON.stringify([container]) } : { code: 1, stderr: "No such container" };
    return {};
  };
}

const environmentOf = (home: string) => readFileSync(join(home, ".local/share/fleet-mcphub/runtime.env"), "utf8").split("\n").filter(Boolean);

function dockerHost(home: string) {
  let container: { Config: { Labels: Record<string, string>; Env: string[] }; Image: string; State: { Running: boolean } } | undefined;
  return (call: RunCall) => {
    const [tool, noun, verb] = call.command;
    if (tool !== "docker") return {};
    if (noun === "container" && verb === "inspect") return container ? { stdout: JSON.stringify([container]) } : { code: 1, stderr: "No such container" };
    if (noun === "image" && verb === "inspect") return { stdout: JSON.stringify([{ Id: `sha256:${call.command[3]}` }]) };
    if (noun === "run") {
      const labels = Object.fromEntries(call.command.flatMap((arg, index) => (call.command[index - 1] === "--label" ? [arg.split("=")] : [])));
      container = { Config: { Labels: { ...labels, "org.fleet.patch": "1.1.0-elicitation" }, Env: [...environmentOf(home), "PATH=/usr/local/bin"] }, Image: `sha256:${call.command.at(-2)}`, State: { Running: true } };
    }
    if (noun === "stop") container!.State.Running = false;
    if (noun === "rm") container = undefined;
    return {};
  };
}

const startCommand = (home: string, image: string) => ["docker", "run", "-d", "--name", "fleet-mcphub", "--label", "org.fleet.service=mcphub", "--restart", "unless-stopped",
  "--user", "1000:1000", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--env-file", join(home, ".local/share/fleet-mcphub/runtime.env"),
  "-p", "127.0.0.1:3317:3000", "-v", `${join(home, ".local/share/fleet-mcphub")}/data:/app/data`, "-v", `${join(home, ".local/share/fleet-mcphub")}/logs:/app/logs`,
  "--entrypoint", "node", image, "dist/index.js"];

test("install runs only on Linux", async () => {
  await expect(install(fakeHub(hubHome(), { platform: "darwin" }))).rejects.toThrow("Install MCPHub on the Linux hub.");
});

test("install starts the built image on loopback port 3317 with no secret in argv, then syncs the fleet group once MCPHub answers", async () => {
  const home = hubHome();
  const api = fakeMcpHub({ notReadyFor: 2, home });
  const { calls, run } = fakeRun(docker());
  const slept: number[] = [];
  const hub = fakeHub(home, { run, fetch: mcphubFetch(api), sleep: async (ms) => { slept.push(ms); } });
  await install(hub);
  const image = calls[0]!.command[3]!;
  expect(image).toMatch(/^fleet-mcphub:1\.1\.0-[0-9a-f]{12}$/);
  expect(calls.map((call) => call.command)).toEqual([["docker", "image", "inspect", image], ["docker", "container", "inspect", "fleet-mcphub"], ["docker", "image", "inspect", image], startCommand(home, image)]);
  const secrets = readFileSync(join(home, ".local/share/fleet-mcphub/runtime.env"), "utf8").match(/=([\w-]{43})$/gm)!.map((line) => line.slice(1));
  expect(secrets).toHaveLength(2);
  for (const secret of secrets) expect(JSON.stringify(calls)).not.toContain(secret);
  expect(slept).toEqual([500, 500]);
  expect(api.groups).toEqual([{ id: "group-1", name: "fleet", servers: ["tickets", "calendar"] }]);
  expect(hub.printed).toEqual(["MCPHub installed: https://hub.internal.example.com:60001/mcphub/"]);
});

test("install keeps a running container of the same image, starts a stopped one, and replaces one of an older image", async () => {
  const label = { "org.fleet.service": "mcphub" };
  const image = (calls: RunCall[]) => calls[0]!.command[3]!;
  const sameImage = (home: string, running: boolean) => {
    const fake: ReturnType<typeof fakeRun> = fakeRun((call) => docker({ Config: { Labels: label, Env: environmentOf(home) }, Image: `sha256:${image(fake.calls)}`, State: { Running: running } })(call));
    return fake;
  };
  const keptHome = hubHome();
  const kept = sameImage(keptHome, true);
  await install(fakeHub(keptHome, { run: kept.run }));
  expect(kept.calls.filter((call) => !call.command.includes("inspect"))).toEqual([]);
  const stoppedHome = hubHome();
  const stopped = sameImage(stoppedHome, false);
  await install(fakeHub(stoppedHome, { run: stopped.run }));
  expect(stopped.calls.filter((call) => !call.command.includes("inspect")).map((call) => call.command)).toEqual([["docker", "start", "fleet-mcphub"]]);
  const home = hubHome();
  const old = fakeRun(docker({ Config: { Labels: label }, Image: "sha256:older", State: { Running: true } }));
  await install(fakeHub(home, { run: old.run }));
  expect(old.calls.filter((call) => !call.command.includes("inspect")).map((call) => call.command)).toEqual([["docker", "stop", "fleet-mcphub"], ["docker", "rm", "fleet-mcphub"], startCommand(home, image(old.calls))]);
});

test("installing again after the hub gets an HTTPS host moves MCPHub to that address and keeps every secret", async () => {
  const home = hubHome();
  const docker = fakeRun(dockerHost(home));
  await install(fakeHub(home, { run: docker.run, gateway: { relayPort: 60001 } }));
  const settingsPath = join(home, ".local/share/fleet-mcphub/data/mcp_settings.json");
  const environmentPath = join(home, ".local/share/fleet-mcphub/runtime.env");
  const before = { settings: JSON.parse(readFileSync(settingsPath, "utf8")), environment: environmentOf(home) };
  expect(before.settings.systemConfig.install.baseUrl).toBe("http://127.0.0.1:3317/mcphub");
  const oldEnvironment = join(home, "old-runtime-env");
  linkSync(environmentPath, oldEnvironment);
  docker.calls.length = 0;
  const hub = fakeHub(home, { run: docker.run });
  await install(hub);
  const after = { settings: JSON.parse(readFileSync(settingsPath, "utf8")), environment: environmentOf(home) };
  expect(after.settings.systemConfig.install.baseUrl).toBe("https://hub.internal.example.com:60001/mcphub");
  expect(after.settings.bearerKeys).toEqual(before.settings.bearerKeys);
  expect(after.environment).toEqual(before.environment.map((line: string) => (line.startsWith("INSTALL_BASE_URL=") ? "INSTALL_BASE_URL=https://hub.internal.example.com:60001/mcphub" : line)));
  expect(readFileSync(oldEnvironment, "utf8")).toContain("INSTALL_BASE_URL=http://127.0.0.1:3317/mcphub");
  for (const path of [settingsPath, environmentPath]) expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(docker.calls.filter((call) => !call.command.includes("inspect")).map((call) => call.command.slice(0, 2))).toEqual([["docker", "stop"], ["docker", "rm"], ["docker", "run"]]);
  expect(hub.printed).toEqual(["MCPHub installed: https://hub.internal.example.com:60001/mcphub/"]);
  docker.calls.length = 0;
  await install(fakeHub(home, { run: docker.run }));
  expect(docker.calls.filter((call) => !call.command.includes("inspect"))).toEqual([]);
});

test("install keeps a container named fleet-mcphub that Fleet did not make", async () => {
  const { calls, run } = fakeRun(docker({ Config: { Labels: {} }, Image: "sha256:other", State: { Running: true } }));
  await expect(install(fakeHub(hubHome(), { run }))).rejects.toThrow("Keep unmanaged Docker container fleet-mcphub. Review it before installation.");
  expect(calls.some((call) => ["run", "stop", "rm"].includes(call.command[1]!))).toBe(false);
});

test("the build checks the pinned source archive, applies the approval patch, and layers only the compiled files and the SDK", async () => {
  const archive = new TextEncoder().encode("mcphub source");
  const source = { url: "https://codeload.example.com/mcphub.tar.gz", sha256: createHash("sha256").update(archive).digest("hex") };
  let dockerfile = "";
  const { calls, run } = fakeRun((call) => {
    const [tool, noun, verb] = call.command;
    if (tool === "docker" && noun === "image" && verb === "inspect") return { code: 1 };
    if (tool === "docker" && noun === "run") {
      const output = call.command[call.command.indexOf("-v", call.command.indexOf("-v") + 1) + 1]!.split(":")[0]!;
      for (const file of ["clients/legacyMcpClient.js", "services/mcpService.js"]) mkdirSync(join(output, file, ".."), { recursive: true }), writeFileSync(join(output, file), file);
    }
    if (tool === "docker" && noun === "build") dockerfile = readFileSync(join(call.command[4]!, "Dockerfile"), "utf8");
    return {};
  });
  const fetched: string[] = [];
  const hub = fakeHub(hubHome(), { run, fetch: async (url) => (fetched.push(String(url)), new Response(archive)) });
  const image = await buildImage(hub, source);
  expect(fetched).toEqual([source.url]);
  const steps = calls.map((call) => call.command.slice(0, 2).join(" "));
  expect(steps).toEqual(["docker image", "tar xzf", "git apply", "docker run", "docker build"]);
  expect(calls[2]!.command[2]).toBe(join(hub.root, "mcphub/1.1.0-elicitation.patch"));
  expect(calls[3]!.command).toContain(mcphubImage);
  expect(calls[4]!.command.slice(0, 4)).toEqual(["docker", "build", "-t", image]);
  expect(dockerfile).toStartWith(`FROM ${mcphubImage}\nCOPY sdk/ /fleet-sdk/\n`);
  expect(dockerfile).not.toMatch(/grafana|codex|slack/i);
  expect(existsSync(calls[4]!.command[4]!)).toBe(false);
});

test("the build refuses a source archive whose checksum does not match", async () => {
  const { calls, run } = fakeRun((call) => (call.command[1] === "image" ? { code: 1 } : {}));
  const hub = fakeHub(hubHome(), { run, fetch: async () => new Response("tampered") });
  await expect(buildImage(hub, { url: "https://codeload.example.com/mcphub.tar.gz", sha256: "0".repeat(64) })).rejects.toThrow("MCPHub source checksum mismatch");
  expect(calls.map((call) => call.command[0])).toEqual(["docker"]);
});
