import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { overSsh, pairing, profileForBox, sshHosts } from "./devbox.ts";
import { claudeProbeTimeoutMs } from "./signins.ts";
import { deadEnvironmentToken, fakeMachine, fleetSetup, machineFile, onBox, remote } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

function homeWithHosts(config = "Host node-1\n  HostName 10.0.0.5\nHost *.internal !bastion\nhost node-2 node-3\nMatch host x\n") {
  const home = temp.make("home-");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/config"), config);
  return home;
}

describe("the devbox over SSH", () => {
  test("lists the concrete hosts in ~/.ssh/config", () => {
    expect(sshHosts(homeWithHosts())).toEqual(["node-1", "node-2", "node-3"]);
    expect(sshHosts(temp.make("home-"))).toEqual([]);
  });

  test("runs box commands over SSH with the tools on PATH, in a scratch directory when asked", async () => {
    const box = fakeMachine(temp.make("home-"));
    await overSsh(box.machine, "node-1").exec(["codex", "exec", "it's ok"], { cwd: "/tmp/x", timeoutMs: 20000 });
    expect(box.calls[0]).toEqual({
      command: ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "node-1", `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; d=$(mktemp -d) && cd "$d" && codex exec 'it'\\''s ok'; s=$?; cd / && rm -rf "$d"; exit $s`],
      timeoutMs: 20000,
    });
  });

  test("reads the origin and the code from t3 pair", () => {
    expect(pairing("Pairing with box.\n\nPairing URL: https://box.example/pair#token=x\nApp link: t3://x\nToken: ABC123\n")).toEqual({ url: "https://box.example", code: "ABC123" });
    expect(pairing("no server running")).toBeUndefined();
  });

  test("installs Fleet on the chosen host, signs it in with the codes shown here, applies the profile, and links T3 Code both ways", async () => {
    const home = homeWithHosts();
    const box = fakeMachine(home, { "box:github": 1, "box:claude": 1, "box:chatgpt": 2, "box:t3": 1 });
    const result = await fleetSetup(home, ["--preset", "starter"], ["", "", "", "1"], box);
    expect(result.code).toBe(0);
    expect(result.output).toContain("? Which SSH host is your devbox?");
    expect(result.output).toContain("  1) node-1");
    expect(result.output).toContain("  Devbox          node-1: the same profile, signed in, linked with T3 Code here, and it makes signed commits.");
    expect(result.output).toContain("  ✓ node-1 makes signed commits");
    expect(machineFile(home).devboxes).toEqual(["node-1"]);

    const onTheBox = remote(box);
    expect(onTheBox).toContainEqual(expect.stringMatching(/curl -fsSL \S+\/get\.sh -o "\$installer" && sh "\$installer" --ref main --install-only/));
    expect(onTheBox).toContain("gh auth login --hostname github.com --git-protocol https --web --scopes repo,read:org,admin:public_key,admin:ssh_signing_key");
    expect(onTheBox).toContain("gh auth setup-git");
    expect(onTheBox).toContainEqual(expect.stringContaining(`gh repo clone https://github.com/nora/fleet-profile.git "$HOME/.local/share/fleet/profile" -- -q && sh "$HOME/.local/share/fleet/engine/get.sh" --ref main --profile "$HOME/.local/share/fleet/profile"`));
    expect(onTheBox).toContain("codex login --device-auth");
    expect(onTheBox).toContain("t3 up --connect --yes --headless");
    expect(box.runs).toContainEqual({ command: ["ssh", "-t", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "node-1", expect.stringContaining("claude auth login")], input: true });
    expect(box.opened).toEqual(["https://github.com/login/device"]);
    const here = box.calls.map((call) => call.command.join(" "));
    expect(here).toContain("t3 environment link https://box-1.relay.example --pairing-code BOXCODE --access full-access");
    expect(onTheBox).toContain(`t3 pair --ttl 5m --label ${hostname()}`);
    expect(onTheBox).not.toContainEqual(expect.stringContaining("t3 environment link"));
    expect(here).not.toContain("t3 pair --ttl 5m --label node-1");
    expect(result.output).toContain("  · node-1 does not link back to this machine, because T3 Connect is off here. Turn it on with t3 up --connect, and T3 Code on node-1 can pair with this machine.");
  });

  test("links back from the devbox when T3 Connect is on here, and installs the engine of a tracking profile from main", async () => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { connectHere: true });
    const result = await fleetSetup(home, ["--preset", "starter", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.code).toBe(0);
    expect(remote(box)).toContain("t3 environment link https://here.relay.example --pairing-code HERECODE --access full-access");

    const dir = join(home, ".local/share/fleet/profile");
    const file = JSON.parse(readFileSync(join(dir, "fleet.json"), "utf8"));
    writeFileSync(join(dir, "fleet.json"), JSON.stringify({ ...file, engine: { ...file.engine, ref: "v0.1.0", channel: "track" } }));
    expect((await profileForBox(box.machine, dir)).engineRef).toBe("main");
  });

  test("links the devbox at the tunnel hostname that t3 connect status prints, not at the shared relay", async () => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { cliPrintsTunnel: true });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.code).toBe(0);
    expect(box.calls.map((call) => call.command.join(" "))).toContain("t3 environment link https://box-1.relay.example --pairing-code BOXCODE --access full-access");
    expect(box.sessions()).toEqual([]);
  });

  test("with a T3 CLI that prints no tunnel hostname, reads it from the T3 server there with a session it revokes and never shows", async () => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { connectHere: true });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.code).toBe(0);
    expect(box.calls.map((call) => call.command.join(" "))).toContain("t3 environment link https://box-1.relay.example --pairing-code BOXCODE --access full-access");
    expect(remote(box)).toContain("t3 environment link https://here.relay.example --pairing-code HERECODE --access full-access");
    const sessions = box.sessions();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.filter((session) => !session.revoked)).toEqual([]);
    for (const { token } of sessions) {
      expect(result.output).not.toContain(token);
      expect(box.calls.flatMap((call) => call.command)).not.toContainEqual(expect.stringContaining(token));
    }
  });

  test("stops before linking, and says to update T3 Code, when neither the T3 CLI nor its server gives the tunnel hostname", async () => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { serverWithoutLinkState: ["box"] });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("node-1 has no T3 Connect address yet. Update T3 Code on node-1, then run fleet setup again.");
    expect(box.calls.map((call) => call.command.join(" "))).not.toContainEqual(expect.stringContaining("t3 environment link"));
    expect(box.sessions().filter((session) => !session.revoked)).toEqual([]);
  });

  test.each([
    ["a server record that is not on this machine", { runtimeOrigin: "http://192.0.2.7:41773" }],
    ["a loopback-looking name on another domain", { runtimeOrigin: "http://127.0.0.1.evil.example:41773" }],
    ["userinfo in front of another host", { runtimeOrigin: "http://127.0.0.1@evil.example:41773" }],
    ["an https origin", { runtimeOrigin: "https://127.0.0.1:41773" }],
    ["a pid that is not a number", { runtimePid: "4242" }],
    ["a pid that names every process", { runtimePid: -1 }],
    ["a pid of 0", { runtimePid: 0 }],
    ["a pid that is not whole", { runtimePid: 4242.5 }],
    ["localhost, which curl and T3 may resolve to different listeners", { runtimeOrigin: "http://localhost:41773" }],
    ["a server record whose process is gone", { serverGone: true }],
  ])("never issues a T3 session for %s", async (_, server) => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, server);
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.output).toContain("node-1 has no T3 Connect address yet. Update T3 Code on node-1, then run fleet setup again.");
    expect(box.sessions()).toEqual([]);
  });

  test("reads the tunnel from a T3 server that its record names in another spelling and at another port", async () => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { runtimeOrigin: "HTTP://127.0.0.1:52000/path?q=x" });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.code).toBe(0);
    expect(remote(box)).toContainEqual(expect.stringContaining("http://127.0.0.1:52000/api/connect/link-state"));
    expect(box.calls.map((call) => call.command.join(" "))).toContain("t3 environment link https://box-1.relay.example --pairing-code BOXCODE --access full-access");
  });

  test.each([
    ["signed in but not linked", { authenticated: true, linked: false }],
    ["linked but not signed in", { authenticated: false, linked: true }],
    ["signed in, with linked as the text true", { authenticated: true, linked: "true" }],
    ["linked, with authenticated as 1", { authenticated: 1, linked: true }],
  ])("never links a box whose T3 Connect is %s", async (_, boxConnect) => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { boxConnect, exits: { "box:t3": 0 } });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.output).toContain("but Link T3 Connect on node-1 still does not pass its check");
    expect(box.calls.map((call) => call.command.join(" "))).not.toContainEqual(expect.stringContaining("t3 environment link"));
    expect(box.sessions()).toEqual([]);
  });

  test.each([
    ["~ that T3 expands", () => "~/.t3"],
    ["a relative path that T3 resolves", () => "relative/t3"],
    ["blanks that T3 ignores", () => "  "],
    ["a trailing blank that T3 trims", (home: string) => `${home}/t3 `],
    ["a .. that T3 resolves before the link it passes through", (home: string) => (mkdirSync(join(home, "deep", "inner"), { recursive: true }), symlinkSync(join(home, "deep", "inner"), join(home, "x")), `${home}/x/../t3`)],
    ["a trailing .. that T3 resolves before the link it passes through", (home: string) => (mkdirSync(join(home, "deep", "inner"), { recursive: true }), symlinkSync(join(home, "deep", "inner"), join(home, "x")), `${home}/x/..`)],
  ])("never issues a T3 session when T3CODE_HOME holds %s", async (_, t3Home) => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { t3Home: t3Home(home), connectHere: true });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.output).toContain("node-1 has no T3 Connect address yet.");
    expect(box.sessions()).toEqual([]);
    expect(box.calls.flatMap((call) => call.command).join(" ")).not.toContain(":6666");
  });

  test("reads the T3 record under an absolute T3CODE_HOME, and none while a dev server moves T3's state", async () => {
    const home = homeWithHosts();
    const custom = fakeMachine(home, {}, { t3Home: join(home, "custom-t3") });
    expect((await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], custom)).code).toBe(0);
    expect(remote(custom)).toContainEqual(expect.stringContaining("http://127.0.0.1:41773/api/connect/link-state"));

    const devHome = homeWithHosts();
    const dev = fakeMachine(devHome, {}, { devServerUrl: "http://127.0.0.1:5173" });
    expect((await fleetSetup(devHome, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], dev)).output).toContain("node-1 has no T3 Connect address yet.");
    expect(dev.sessions()).toEqual([]);
  });

  test.each([
    ["the IPv6 loopback", { runtimeOrigin: "http://[::1]:41773" }, "box-1.relay.example", "http://[::1]:41773/api/connect/link-state"],
    ["a tunnel hostname in capitals", { cliPrintsTunnel: true, boxTunnel: "Box-1.Relay.Example" }, "Box-1.Relay.Example", undefined],
    ["a recorded pid other than the usual one", { runtimePid: 77 }, "box-1.relay.example", undefined],
    ["a 253-character tunnel hostname", { cliPrintsTunnel: true, boxTunnel: [..."abc"].map((c) => c.repeat(63)).concat("d".repeat(61)).join(".") }, [..."abc"].map((c) => c.repeat(63)).concat("d".repeat(61)).join("."), undefined],
  ])("links the box through %s", async (_, server, tunnel, lookup) => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, server);
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.code).toBe(0);
    expect(box.calls.map((call) => call.command.join(" "))).toContain(`t3 environment link https://${tunnel} --pairing-code BOXCODE --access full-access`);
    if (lookup) expect(remote(box)).toContainEqual(expect.stringContaining(lookup));
  });

  test("waits for a tunnel that is still starting after T3 Connect links", async () => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { tunnelStartsAfter: 3 });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.code).toBe(0);
    expect(box.calls.map((call) => call.command.join(" "))).toContain("t3 environment link https://box-1.relay.example --pairing-code BOXCODE --access full-access");
    expect(box.sessions().filter((session) => !session.revoked)).toEqual([]);
  });

  test.each(["a..b", ".", "-box.example", "box_1.example", `${"a".repeat(64)}.example`, "bücher.example", "box.example:8443", "user@box.example", "box.example/path", "box-.example", "localhost", ["a".repeat(63), "a".repeat(63), "a".repeat(63), "a".repeat(62)].join("."), Array(4).fill("a".repeat(63)).join(".")])("refuses the tunnel hostname %s", async (tunnel) => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { cliPrintsTunnel: true, boxTunnel: tunnel });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.output).toContain("node-1 has no T3 Connect address yet.");
    expect(box.calls.map((call) => call.command.join(" "))).not.toContainEqual(expect.stringContaining("t3 environment link"));
  });

  test("says so when T3 Connect is on here but its tunnel address cannot be found, instead of calling it off", async () => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { connectHere: true, serverWithoutLinkState: ["here"] });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.code).toBe(0);
    expect(result.output).toContain("T3 Connect is on here, but Fleet could not find this machine's tunnel address. Update T3 Code here, then run fleet setup again so node-1 links back.");
    expect(result.output).not.toContain("because T3 Connect is off here");
  });

  test("a skip, or no host in ~/.ssh/config, leaves a plan for this machine only", async () => {
    for (const home of [homeWithHosts(), temp.make("home-")]) {
      const box = fakeMachine(home);
      const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", "", ""], box);
      expect(result.code).toBe(0);
      expect(result.output).toContain("  ✓ No devbox for now. Add one later with fleet devbox add <host>.");
      expect(remote(box)).toEqual([]);
      expect(machineFile(home).devboxes).toEqual([]);
    }
  });

  test("a box whose Claude token from its environment is dead stops with how to refresh it, not with claude auth login", async () => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { claude: { "box:claude": deadEnvironmentToken } });
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", "node-1"], ["", "", ""], box);
    expect(result.output).toContain("The CLAUDE_CODE_OAUTH_TOKEN that node-1 gets from its environment is no longer valid");
    expect(result.output).toContain("hogli devbox:setup --configure-claude");
    expect(box.calls.find((call) => onBox(call.command) === "claude -p ok")?.timeoutMs).toBe(claudeProbeTimeoutMs);
    expect(box.runs.map((run) => run.command.join(" "))).not.toContainEqual(expect.stringContaining("claude auth login"));
  });

  test("--devbox picks the host without asking, and a run without a person lists the box sign-ins it needs", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, { "box:github": 1 });
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "node-9"], [], box);
    expect(result.code).toBe(2);
    expect(result.output).toContain("  Sign in to GitHub on node-9: do it once in a terminal, then run fleet setup again");
    expect(remote(box)).toContainEqual(expect.stringContaining("--install-only"));
    expect(box.starts).toEqual([]);
  });

  test("fleet setup refuses a devbox name the hub cannot use, or a pool box name, and its list of SSH hosts leaves them out", async () => {
    for (const [host, says] of [
      ["box-7", "fleet setup: box-7 is a pool box name. Names that start with box- are kept for the boxes the hub starts; give the devbox another SSH name."],
      ["Node-1", "fleet setup: Node-1 is not a name the hub can use."],
    ]) {
      const home = temp.make("home-");
      const box = fakeMachine(home);
      const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude", "--devbox", host!], [], box);
      expect(result.code).toBe(2);
      expect(result.output).toStartWith(says!);
      expect(remote(box)).toEqual([]);
    }
    const home = homeWithHosts("Host box-1 Node-2 node-3\n");
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", "", "1"], fakeMachine(home));
    expect(result.output).toContain("  1) node-3");
    expect(result.output).not.toContain(") box-1");
    expect(result.output).not.toContain(") Node-2");
    expect(machineFile(home).devboxes).toEqual(["node-3"]);
  });
});
