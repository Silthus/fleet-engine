import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { overSsh, pairing, profileForBox, sshHosts } from "./devbox.ts";
import { fakeMachine, fleetSetup, machineFile, onBox, remote } from "./testing.ts";

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
