import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../src/testing/git.ts";
import { spawnAsync } from "../../src/testing/spawn.ts";

const temp = tempDirs();
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  temp.cleanup();
});

const cli = join(import.meta.dir, "../../src/cli.ts");
const random = () => crypto.randomUUID().replaceAll("-", "");
const token = ["page", "token", random()].join("-");
const sourceId = ["01", random().toUpperCase()].join("");
const accepted = { status: "accepted", message: "Event accepted for processing" };

type Received = { path: string; authorization: string | null; body: Record<string, unknown> };

function fakeIncidentIo() {
  const received: Received[] = [];
  const state = { refuse: false, emptyBody: false };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      received.push({ path, authorization: request.headers.get("authorization"), body: await request.json() });
      if (state.refuse) return Response.json({ type: "validation_error", status: 422, errors: [{ code: "invalid", message: `token ${token} is not valid for ${request.url}` }] }, { status: 422 });
      return state.emptyBody ? new Response("null", { status: 202 }) : Response.json(accepted, { status: 202 });
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v2/alert_events/http/${sourceId}`, received, state };
}

function closedPort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const url = `http://127.0.0.1:${server.port}/v2/alert_events/http/${sourceId}`;
  server.stop(true);
  return url;
}

type Ran = { code: number; output: string };

async function spawnFleet(home: string, path: string, args: string[], stdin?: string): Promise<Ran> {
  const ran = await spawnAsync([process.execPath, cli, ...args], { env: { HOME: home, PATH: path, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin) });
  return { code: ran.exitCode, output: (ran.stdout + ran.stderr).trimEnd() };
}

function profile(fields: Record<string, unknown> = {}) {
  const dir = temp.make("profile-");
  writeFileSync(join(dir, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["incident-io"], plan: "claude", settings: {}, workflows: { "page-owner": true }, ...fields }));
  return dir;
}

function machineHome(profileDir: string, machine: Record<string, unknown>) {
  const home = temp.make("home-");
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, ...machine, profileDir }));
  return home;
}

const storeFile = (home: string) => join(home, ".config/fleet/secrets/incident-io/source");

function bunPath() {
  const bin = temp.make("bin-");
  symlinkSync(process.execPath, join(bin, "bun"));
  return `${bin}:/usr/bin:/bin`;
}

function solo(workflow = true) {
  const home = machineHome(profile({ workflows: { "page-owner": workflow } }), { role: "linux", name: "solo-1" });
  const path = bunPath();
  const fleet = (...args: string[]) => spawnFleet(home, path, args);
  const setup = (url: string, input = `${token}\n`) => spawnFleet(home, path, ["page", "setup", url], input);
  return { home, fleet, setup };
}

function linked(hub: "up" | "down" = "up", workflow = true) {
  const shared = profile({ hub: "hub-1", devboxes: ["node-2"], workflows: { "page-owner": workflow } });
  const nodeHome = machineHome(shared, { role: "devbox", coder: true, name: "node-2" });
  const hubHome = machineHome(shared, { role: "linux", name: "hub-1" });
  const bin = temp.make("bin-");
  const sshLog = join(bin, "ssh-args.log");
  const path = `${bin}:/usr/bin:/bin`;
  mkdirSync(join(hubHome, ".local/share/fleet/engine"), { recursive: true });
  writeFileSync(join(hubHome, ".local/share/fleet/engine/fleet"), `exec "${process.execPath}" "${cli}" "$@"\n`);
  const reach = hub === "down"
    ? `echo "ssh: connect to host hub-1 port 22: Connection refused" >&2\nexit 255`
    : `for line; do :; done\nexec env HOME="${hubHome}" PATH="${path}" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 sh -c "$line"`;
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nfor word; do printf '%s\\n' "$word"; done >> "${sshLog}"\necho --- >> "${sshLog}"\n${reach}\n`, { mode: 0o755 });
  const sshCalls = () => (existsSync(sshLog) ? readFileSync(sshLog, "utf8").split("---\n").filter(Boolean) : []);
  return {
    nodeHome,
    hubHome,
    sshCalls,
    node: (...args: string[]) => spawnFleet(nodeHome, path, args),
    nodeSetup: (url: string) => spawnFleet(nodeHome, path, ["page", "setup", url], `${token}\n`),
    hub: (...args: string[]) => spawnFleet(hubHome, path, args),
    hubSetup: (url: string) => spawnFleet(hubHome, path, ["page", "setup", url], `${token}\n`),
  };
}

function filesHolding(home: string, secret: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = statSync(path, { throwIfNoEntry: false });
      if (info?.isDirectory()) walk(path);
      else if (info?.isFile() && readFileSync(path).includes(secret)) found.push(path);
    }
  };
  walk(home);
  return found;
}

const tellsNoSecret = (ran: Ran) => [token, sourceId].filter((secret) => ran.output.includes(secret));

const fire = ["page", "--key", "rollout-errors", "--title", "Rollout: errors over the tripwire", "--description", "Undo: switch the flag off.", "--source-url", "https://dashboards.example/rollout"];

test("setup saves the source where only the owner can read it, a page fires once, and the same key resolves it", async () => {
  const incident = fakeIncidentIo();
  const { home, fleet, setup } = solo();
  expect(await setup(incident.url)).toEqual({ code: 0, output: 'fleet page: saved the alert source. Check it with: fleet page --key setup-check --title "Setup check" --dry-run' });
  expect(statSync(storeFile(home)).mode & 0o777).toBe(0o600);

  const fired = await fleet(...fire);
  expect(fired).toEqual({ code: 0, output: "fleet page: sent rollout-errors. HTTP 202: accepted: Event accepted for processing" });
  const resolved = await fleet("page", "--key", "rollout-errors", "--resolve");
  expect(resolved).toEqual({ code: 0, output: "fleet page: resolved rollout-errors. HTTP 202: accepted: Event accepted for processing" });

  expect(incident.received).toEqual([
    {
      path: `/v2/alert_events/http/${sourceId}`,
      authorization: `Bearer ${token}`,
      body: { title: "Rollout: errors over the tripwire", status: "firing", deduplication_key: "rollout-errors", description: "Undo: switch the flag off.", source_url: "https://dashboards.example/rollout", metadata: { sent_by: "fleet page" } },
    },
    { path: `/v2/alert_events/http/${sourceId}`, authorization: `Bearer ${token}`, body: { title: "Resolved: rollout-errors", status: "resolved", deduplication_key: "rollout-errors", metadata: { sent_by: "fleet page" } } },
  ]);
  expect(filesHolding(home, token)).toEqual([storeFile(home)]);
});

test("a refused event exits 1 with incident.io's own words, and hides the token and the source in them", async () => {
  const incident = fakeIncidentIo();
  incident.state.refuse = true;
  const { fleet, setup } = solo();
  await setup(incident.url);
  const refused = await fleet(...fire);
  expect(refused).toEqual({ code: 1, output: "fleet page: incident.io did not accept the event. HTTP 422: 422: token [redacted] is not valid for [redacted]. Send it again with the same --key: it never pages twice." });
  expect(tellsNoSecret(refused)).toEqual([]);
});

test("an alert source that does not answer exits 1, and the error names neither the URL nor the source", async () => {
  const { fleet, setup } = solo();
  await setup(closedPort());
  const ran = await fleet(...fire);
  expect(ran.code).toBe(1);
  expect(ran.output).toStartWith("fleet page: not sent: ");
  expect(ran.output).toEndWith("Send it again with the same --key: it never pages twice.");
  expect(tellsNoSecret(ran)).toEqual([]);
  expect(ran.output).not.toContain("127.0.0.1");
});

test("doctor names the setup as a to-do until the source is saved", async () => {
  const todo = 'To do: Save your incident.io alert source for the page-owner workflow. When one is saved and this stays, fleet page --key setup-check --title "Setup check" --dry-run says what is wrong with it. Follow packs/incident-io/SETUP.md, which ends with: fleet page setup <alert source URL> < <token file>';
  const { fleet, setup } = solo();
  expect((await fleet("doctor")).output).toContain(todo);
  await setup(closedPort());
  expect((await fleet("doctor")).output).not.toContain("incident.io");
});

test("without a saved source, a page exits 1 and says how to set one up", async () => {
  expect(await solo().fleet(...fire)).toEqual({ code: 1, output: "fleet page: no incident.io alert source is saved. Set it up: fleet page setup <alert source URL> < <token file>" });
});

test("a saved source that other users can read, or that is a link, sends nothing", async () => {
  const incident = fakeIncidentIo();
  const { home, fleet, setup } = solo();
  await setup(incident.url);
  chmodSync(storeFile(home), 0o644);
  expect(await fleet(...fire)).toEqual({ code: 1, output: "fleet page: ~/.config/fleet/secrets/incident-io/source is open to other users. Run chmod 600 ~/.config/fleet/secrets/incident-io/source, or save the secret again." });
  chmodSync(storeFile(home), 0o600);
  renameSync(storeFile(home), join(home, "moved"));
  symlinkSync(join(home, "moved"), storeFile(home));
  expect(await fleet(...fire)).toEqual({ code: 1, output: "fleet page: ~/.config/fleet/secrets/incident-io/source is a link. A secret must be a file of its own: delete it and save the secret again." });
  expect(incident.received).toEqual([]);
});

test("a saved source with a URL outside incident.io sends nothing", async () => {
  const foreign = Bun.serve({ hostname: "127.0.0.2", port: 0, fetch: () => new Response() });
  stops.push(() => foreign.stop(true));
  const { home, fleet, setup } = solo();
  await setup(closedPort());
  for (const url of [`https://example.com/v2/alert_events/http/${sourceId}`, `http://127.0.0.2:${foreign.port}/v2/alert_events/http/${sourceId}`, `https://api.incident.io/v2/alerts/${sourceId}`, `https://api.incident.io:8443/v2/alert_events/http/${sourceId}`]) {
    writeFileSync(storeFile(home), JSON.stringify({ url, token }), { mode: 0o600 });
    const ran = await fleet(...fire);
    expect([url, ran.code, ran.output.replace(/ URL .*?\. Save/, " URL <problem>. Save")]).toEqual([url, 1, "fleet page: the saved alert source URL <problem>. Save it again: fleet page setup <alert source URL> < <token file>"]);
  }
});

test("setup refuses a URL outside incident.io and a token that is not one line, and saves nothing", async () => {
  const { home, setup } = solo();
  expect(await setup(`https://example.com/v2/alert_events/http/${sourceId}`)).toEqual({ code: 2, output: "fleet page: the alert source URL is not an https://api.incident.io URL\nRun fleet page --help for the flags." });
  expect(await setup(`https://api.incident.io/v2/alert_events/http/${sourceId}?x=1`)).toEqual({ code: 2, output: "fleet page: the alert source URL has more than a path\nRun fleet page --help for the flags." });
  expect(await setup(`https://api.incident.io/v2/alert_events/http/${sourceId}`, `${token}\nsecond line\n`)).toEqual({ code: 2, output: "fleet page: standard input must hold the alert source token alone, on one line\nRun fleet page --help for the flags." });
  expect(await setup(`https://api.incident.io/v2/alert_events/http/${sourceId}`, "")).toEqual({ code: 2, output: "fleet page: standard input must hold the alert source token alone, on one line\nRun fleet page --help for the flags." });
  expect(existsSync(storeFile(home))).toBe(false);
});

test("a dry run checks the input and the saved source, shows the event without the token, and sends nothing", async () => {
  const incident = fakeIncidentIo();
  const { fleet, setup } = solo();
  await setup(incident.url);
  const dry = await fleet(...fire, "--dry-run");
  expect(dry.code).toBe(0);
  expect(dry.output).toStartWith("fleet page: dry run, nothing sent. It would POST this to the saved alert source:\nAuthorization: Bearer [redacted]\n");
  expect(JSON.parse(dry.output.slice(dry.output.indexOf("{")))).toMatchObject({ status: "firing", deduplication_key: "rollout-errors", description: "Undo: switch the flag off." });
  expect(tellsNoSecret(dry)).toEqual([]);
  expect(incident.received).toEqual([]);
});

test("--help and -h print the usage and exit 0, and no flags at all print it and exit 2", async () => {
  const { fleet } = solo();
  for (const help of ["--help", "-h"]) {
    const ran = await fleet("page", help);
    expect([help, ran.code, ran.output.split("\n")[0]]).toEqual([help, 0, "Usage: fleet page --key <key> --title <title> [--description <text>] [--source-url <url>] [--dry-run]"]);
  }
  expect(await fleet("page")).toMatchObject({ code: 2, output: expect.stringMatching(/^Usage: fleet page/) });
});

test("wrong input exits 2 before it reads the source", async () => {
  const { fleet } = solo();
  expect(await fleet("page", "--title", "No key")).toEqual({ code: 2, output: "fleet page: --key is required, so a retry never pages twice\nRun fleet page --help for the flags." });
  expect(await fleet("page", "--key", "k")).toEqual({ code: 2, output: "fleet page: --title is required\nRun fleet page --help for the flags." });
  expect(await fleet("page", "--key", "k", "--title", "t", "--source-url", "file:///etc/passwd")).toEqual({ code: 2, output: "fleet page: --source-url must be an http or https URL\nRun fleet page --help for the flags." });
  expect(await fleet("page", "--key", "k", "--title", "t", "--to", "someone")).toMatchObject({ code: 2, output: expect.stringContaining("Unknown option '--to'") });
  expect(await fleet("page", "--key", "k", "--title", "t", "--priority", "P1")).toMatchObject({ code: 2, output: expect.stringContaining("Unknown option '--priority'") });
});

test("a flag that takes a value never takes the next flag as its value, so --dry-run after it cannot send", async () => {
  const incident = fakeIncidentIo();
  const { fleet, setup } = solo();
  await setup(incident.url);
  for (const eaten of ["--dry-run", "--resolve", "-h", "--help"]) {
    const ran = await fleet("page", "--key", "k", "--title", "t", "--description", eaten);
    expect([eaten, ran.code, ran.output]).toEqual([eaten, 2, expect.stringContaining("Option '--description' argument is ambiguous.")]);
  }
  expect(incident.received).toEqual([]);
  const literal = await fleet("page", "--key", "k", "--title", "t", "--description=--dry-run", "--dry-run");
  expect(literal.code).toBe(0);
  expect(JSON.parse(literal.output.slice(literal.output.indexOf("{")))).toMatchObject({ description: "--dry-run" });
  expect(incident.received).toEqual([]);
});

test("an accepted event with an empty answer still exits 0", async () => {
  const incident = fakeIncidentIo();
  incident.state.emptyBody = true;
  const { fleet, setup } = solo();
  await setup(incident.url);
  expect(await fleet(...fire)).toEqual({ code: 0, output: "fleet page: sent rollout-errors. HTTP 202" });
});

test("while the workflow is off, the machine that holds the source refuses to page and sends nothing, and a node hears the hub's refusal", async () => {
  const incident = fakeIncidentIo();
  const refusal = "fleet: fleet page belongs to the page-owner workflow, which is off. Turn it on with fleet packs --workflows page-owner=on.";
  const saveSource = (home: string) => {
    mkdirSync(join(home, ".config/fleet/secrets/incident-io"), { recursive: true, mode: 0o700 });
    writeFileSync(storeFile(home), JSON.stringify({ url: incident.url, token }), { mode: 0o600 });
  };
  const { home, fleet } = solo(false);
  saveSource(home);
  expect(await fleet(...fire)).toEqual({ code: 1, output: refusal });
  const { node, hubHome, sshCalls } = linked("up", false);
  saveSource(hubHome);
  expect(await node(...fire)).toEqual({ code: 1, output: refusal });
  expect(sshCalls()).toHaveLength(1);
  expect(incident.received).toEqual([]);
});

test("a node pages through the hub in one hop: the hub sends, and the node shows the hub's answer", async () => {
  const incident = fakeIncidentIo();
  const { node, hubSetup, sshCalls } = linked();
  await hubSetup(incident.url);
  expect(await node(...fire, "--dry-run")).toMatchObject({ code: 0, output: expect.stringContaining("fleet page: dry run, nothing sent.") });
  expect(await node(...fire)).toEqual({ code: 0, output: "fleet page: sent rollout-errors. HTTP 202: accepted: Event accepted for processing" });
  expect(incident.received.map((event) => [event.authorization, event.body.title])).toEqual([[`Bearer ${token}`, "Rollout: errors over the tripwire"]]);
  expect(sshCalls()).toHaveLength(2);
  expect(sshCalls()[1]).toContain("hub-1\n");
});

test("setup from a node saves the token on the hub over SSH standard input, never in ssh's arguments or the node's home", async () => {
  const incident = fakeIncidentIo();
  const { node, nodeSetup, nodeHome, hubHome, sshCalls } = linked();
  expect(await nodeSetup(incident.url)).toMatchObject({ code: 0 });
  expect(await node(...fire)).toMatchObject({ code: 0 });
  expect(incident.received).toHaveLength(1);
  expect(sshCalls().filter((call) => call.includes(token))).toEqual([]);
  expect(filesHolding(nodeHome, token)).toEqual([]);
  expect(filesHolding(hubHome, token)).toEqual([storeFile(hubHome)]);
});

test("a hub without a saved source answers once and never forwards again", async () => {
  const { node, sshCalls } = linked();
  expect(await node(...fire)).toEqual({ code: 1, output: "fleet page: no incident.io alert source is saved. Set it up: fleet page setup <alert source URL> < <token file>" });
  expect(sshCalls()).toHaveLength(1);
});

test("the hub pages from its own source without ssh", async () => {
  const incident = fakeIncidentIo();
  const { hub, hubSetup, sshCalls } = linked();
  await hubSetup(incident.url);
  expect(await hub(...fire)).toMatchObject({ code: 0 });
  expect(sshCalls()).toEqual([]);
});

test("when the hub does not answer, a page from a node exits 1 and says ssh exited 255", async () => {
  const { node } = linked("down");
  expect(await node(...fire)).toEqual({ code: 1, output: "ssh: connect to host hub-1 port 22: Connection refused\nfleet page: ssh to the hub hub-1 exited 255. Either ssh could not reach the hub, or the command failed there with 255." });
});
