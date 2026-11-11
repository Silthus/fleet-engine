import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { main } from "../cli.ts";
import { isolateGit, spawnGit, tempDirs } from "../testing/git.ts";
import { profilePath } from "./profile.ts";
import { overSsh, pairing, profileForBox, sshHosts } from "./devbox.ts";
import { boxHome, boxMachineFile, coderToken, engineRoot, fakeMachine, fleetSetup, githubRepo, machineFile, onBox, pushedAnswers, scripted } from "./testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

function homeWithHosts(config = "Host box-1\n  HostName 10.0.0.5\nHost *.internal !bastion\nhost box-2 box-3\nMatch host x\n") {
  const home = temp.make("home-");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/config"), config);
  return home;
}

const remote = (box: ReturnType<typeof fakeMachine>) => [...box.calls.map((call) => onBox(call.command)), ...box.starts.map(onBox), ...box.runs.map((run) => onBox(run.command))].filter(Boolean) as string[];

describe("the devbox over SSH", () => {
  test("lists the concrete hosts in ~/.ssh/config", () => {
    expect(sshHosts(homeWithHosts())).toEqual(["box-1", "box-2", "box-3"]);
    expect(sshHosts(temp.make("home-"))).toEqual([]);
  });

  test("runs box commands over SSH with the tools on PATH, in a scratch directory when asked", async () => {
    const box = fakeMachine(temp.make("home-"));
    await overSsh(box.machine, "box-1").exec(["codex", "exec", "it's ok"], { cwd: "/tmp/x", timeoutMs: 20000 });
    expect(box.calls[0]).toEqual({
      command: ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "box-1", `PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; d=$(mktemp -d) && cd "$d" && codex exec 'it'\\''s ok'; s=$?; cd / && rm -rf "$d"; exit $s`],
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
    expect(result.output).toContain("  1) box-1");
    expect(result.output).toContain("  Devbox          box-1: the same profile, signed in, linked with T3 Code here, and it makes signed commits.");
    expect(result.output).toContain("  ✓ box-1 makes signed commits");
    expect(machineFile(home).devboxes).toEqual(["box-1"]);

    const onTheBox = remote(box);
    expect(onTheBox).toContainEqual(expect.stringMatching(/curl -fsSL \S+\/get\.sh -o "\$installer" && sh "\$installer" --ref main --install-only/));
    expect(onTheBox).toContain("gh auth login --hostname github.com --git-protocol https --web --scopes repo,read:org,admin:public_key,admin:ssh_signing_key");
    expect(onTheBox).toContain("gh auth setup-git");
    expect(onTheBox).toContainEqual(expect.stringContaining(`gh repo clone https://github.com/nora/fleet-profile.git "$HOME/.local/share/fleet/profile" -- -q && sh "$HOME/.local/share/fleet/engine/get.sh" --ref main --profile "$HOME/.local/share/fleet/profile"`));
    expect(onTheBox).toContain("codex login --device-auth");
    expect(onTheBox).toContain("t3 up --connect --yes --headless");
    expect(box.runs).toContainEqual({ command: ["ssh", "-t", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "box-1", expect.stringContaining("claude auth login")], input: true });
    expect(box.opened).toEqual(["https://github.com/login/device"]);
    const here = box.calls.map((call) => call.command.join(" "));
    expect(here).toContain("t3 environment link https://box-1.relay.example --pairing-code BOXCODE --access full-access");
    expect(onTheBox).toContain(`t3 pair --ttl 5m --label ${hostname()}`);
    expect(onTheBox).not.toContainEqual(expect.stringContaining("t3 environment link"));
    expect(here).not.toContain("t3 pair --ttl 5m --label box-1");
    expect(result.output).toContain("  · box-1 does not link back to this machine, because T3 Connect is off here. Turn it on with t3 up --connect, and T3 Code on box-1 can pair with this machine.");
  });

  test("links back from the devbox when T3 Connect is on here, and installs the engine of a tracking profile from main", async () => {
    const home = homeWithHosts();
    const box = fakeMachine(home, {}, { connectHere: true });
    const result = await fleetSetup(home, ["--preset", "starter", "--devbox", "box-1"], ["", "", ""], box);
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
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "box-9"], [], box);
    expect(result.code).toBe(2);
    expect(result.output).toContain("  Sign in to GitHub on box-9: do it once in a terminal, then run fleet setup again");
    expect(remote(box)).toContainEqual(expect.stringContaining("--install-only"));
    expect(box.starts).toEqual([]);
  });

  test("asks the settings only a devbox needs once a devbox is added, saves them to the profile before the box applies it, and a run without a person lists them", async () => {
    const question = "? Which T3 project do the loops and the PR digest run in?";
    const args = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on"];
    const alone = temp.make("home-");
    expect((await fleetSetup(alone, [...args, "--devbox", "skip"], ["", ""], fakeMachine(alone))).output).not.toContain(question);

    const home = temp.make("home-");
    const result = await fleetSetup(home, [...args, "--devbox", "box-1"], ["", "", "~/code/app"], fakeMachine(home));
    expect(result.code).toBe(0);
    const output = result.output;
    expect(output.indexOf(question)).toBeGreaterThan(output.indexOf("  ✓ box-1"));
    expect(output.indexOf(question)).toBeLessThan(output.indexOf("▶ Install Fleet on box-1"));
    expect((await pushedAnswers(home)).settings["orchestration.loopProject"]).toBe("~/code/app");

    const later = temp.make("home-");
    const waiting = await fleetSetup(later, ["--non-interactive", ...args, "--devbox", "box-9"], [], fakeMachine(later));
    expect(waiting.code).toBe(2);
    expect(waiting.output).toContain("  --set orchestration.loopProject=<value>   Which T3 project do the loops and the PR digest run in?");
  });

  test("a devbox setting whose push failed is pushed on the next run before the box is installed", async () => {
    const args = ["--preset", "everyday", "--plan", "claude", "--workflows", "pr-digest=on", "--devbox", "box-1"];
    const home = temp.make("home-");
    expect((await fleetSetup(home, args, ["", ""], fakeMachine(home))).code).toBe(130);
    const rejecting = join(githubRepo(home, "nora/fleet-profile"), "hooks/pre-receive");
    writeFileSync(rejecting, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect((await fleetSetup(home, args, ["~/code/app"], fakeMachine(home))).output).toContain("could not push answers");

    const blocked = await fleetSetup(home, ["--non-interactive", ...args], [], fakeMachine(home));
    expect(blocked.output).toContain("could not push answers: ! [remote rejected] main -> main (pre-receive hook declined). Fix that, then try again.");
    expect(blocked.output).not.toContain("▶ Install Fleet on box-1");

    rmSync(rejecting);
    expect((await fleetSetup(home, ["--non-interactive", ...args], [], fakeMachine(home))).code).toBe(0);
    expect((await pushedAnswers(home)).settings["orchestration.loopProject"]).toBe("~/code/app");
  });

  test("fleet devbox add makes a host a devbox later, and a failed install stops with what to do", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const failing = fakeMachine(home, {}, { failRun: true });
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: failing.machine } })).toBe(1);
    expect(io.output()).toContain("fleet: Fleet did not install on the devbox. Fix what it says above, then run fleet setup again.");

    const box = fakeMachine(home);
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toEndWith("node-2 is your devbox now. It runs your profile, and T3 Code here and there can reach each other.");
    expect(machineFile(home).devboxes).toEqual(["node-2"]);
    expect(machineFile(home).setup.done).toContain("devbox:node-2:link");

    expect(await main(["devbox"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toContain("Your devboxes: node-2");
    expect(await main(["devbox", "remove", "node-2"], options)).toBe(2);
    expect(await main(["devbox", "add", "-oProxyCommand=x"], options)).toBe(2);
    expect((await fleetSetup(temp.make("home-"), ["--devbox", "-oProxyCommand=x"])).output).toStartWith("fleet setup: --devbox takes an SSH host");
  });

  test("fleet devbox add signs a Coder workspace in to Coder and writes its SSH config, so it reaches the hub and the other nodes by their coder. names", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const box = fakeMachine(home, { "box:coder": 1 });
    expect(await main(["devbox", "add", "coder.fleet-node-1"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toContain("  ✓ Sign in to Coder on coder.fleet-node-1: done");
    expect(box.coderSsh).toEqual(["https://coder.example.com"]);
    const login = box.calls.find((call) => onBox(call.command)?.includes("coder login"));
    expect(login?.input).toBe(`${coderToken}\n`);
    expect(box.calls.flatMap((call) => call.command).join(" ")).not.toContain(coderToken);
    expect(io.output()).not.toContain(coderToken);

    const again = fakeMachine(home);
    expect(await main(["devbox", "add", "coder.fleet-node-2"], { ...options, setup: { machine: again.machine } })).toBe(0);
    expect(again.calls.map((call) => call.command.join(" "))).not.toContain("coder tokens create");
    expect(again.coderSsh).toEqual(["https://coder.example.com"]);
  });

  test("fleet devbox add again signs the workspace in anew when its Coder session has expired", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    expect(await main(["devbox", "add", "coder.fleet-node-1"], { ...options, setup: { machine: fakeMachine(home, { "box:coder": 1 }).machine } })).toBe(0);
    const expired = fakeMachine(home, { "box:coder": 1 });
    expect(await main(["devbox", "add", "coder.fleet-node-1"], { ...options, setup: { machine: expired.machine } })).toBe(0);
    expect(expired.coderSsh).toEqual(["https://coder.example.com"]);
  });

  test("fleet devbox add signs a workspace in to this machine's Coder deployment when it is signed in to another one", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const elsewhere = fakeMachine(home, {}, { boxCoderAt: "https://other-coder.example.com" });
    expect(await main(["devbox", "add", "coder.fleet-node-1"], { ...options, setup: { machine: elsewhere.machine } })).toBe(0);
    expect(elsewhere.coderSsh).toEqual(["https://coder.example.com"]);
  });

  test("fleet devbox add stops with what to run when this machine is not signed in to Coder, and leaves other SSH hosts alone", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    const signedOut = fakeMachine(home, { coder: 1, "box:coder": 1 });
    expect(await main(["devbox", "add", "coder.fleet-node-1"], { ...options, setup: { machine: signedOut.machine } })).toBe(1);
    expect(io.output()).toContain("Coder is not signed in on this machine. Run coder login <your Coder address> here, then fleet devbox add coder.fleet-node-1 again.");

    const plain = fakeMachine(home, { "box:coder": 1 });
    expect(await main(["devbox", "add", "node-2"], { ...options, setup: { machine: plain.machine } })).toBe(0);
    expect(plain.coderSsh).toEqual([]);
    expect(io.output()).not.toContain("Sign in to Coder on node-2");
  });

  async function withHub(hub = "coder.fleet-hub") {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const profile = profilePath(home);
    const answers = JSON.parse(readFileSync(join(profile, "fleet.json"), "utf8"));
    writeFileSync(join(profile, "fleet.json"), JSON.stringify({ ...answers, hub }, null, 2) + "\n");
    await spawnGit(profile, "commit", "-q", "-am", "Name the hub");
    await spawnGit(profile, "push", "-q");
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    return { home, io, add: (host: string, box: ReturnType<typeof fakeMachine>) => main(["devbox", "add", host], { ...options, setup: { machine: box.machine } }) };
  }

  test("fleet devbox add lists the node in the profile, and the hub takes it before the node asks it for a credential and links it in T3 Code once the node runs T3", async () => {
    const { home, io, add } = await withHub();
    const box = fakeMachine(home);
    expect(await add("coder.fleet-node-1", box)).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.fleet-node-1"]);
    expect(box.hubUpdates).toEqual(["coder.fleet-hub"]);
    expect(box.credentials).toEqual([{ node: "coder.fleet-node-1", issued: true }]);
    expect(io.output()).toContain("✓ The hub, coder.fleet-hub, took coder.fleet-node-1: its disk watch, tunnels and credentials include it now.");
    expect(box.hubLinked).toEqual(["coder.fleet-node-1"]);
    expect(io.output()).toEndWith("✓ The hub, coder.fleet-hub, linked coder.fleet-node-1 in T3 Code.");

    const down = fakeMachine(home, {}, { hubDown: true });
    expect(await add("coder.fleet-node-2", down)).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.fleet-node-1", "coder.fleet-node-2"]);
    expect(io.output()).toContain("· The hub, coder.fleet-hub, did not answer. It takes coder.fleet-node-2 at its next fleet update, or run fleet update there now.");
    expect(io.output()).toEndWith("· The hub, coder.fleet-hub, has not linked coder.fleet-node-2 in T3 Code yet. Its daily fleet peers renew links it, or run fleet peers link coder.fleet-node-2 there now.");
  });

  test("fleet devbox add pushes the node on the next run when the push of the profile failed", async () => {
    const { home, io, add } = await withHub();
    const rejecting = join(githubRepo(home, "nora/fleet-profile"), "hooks/pre-receive");
    writeFileSync(rejecting, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(await add("coder.fleet-node-1", fakeMachine(home))).toBe(1);
    expect(io.output()).toContain("could not push answers");
    rmSync(rejecting);
    const box = fakeMachine(home);
    expect(await add("coder.fleet-node-1", box)).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.fleet-node-1"]);
    expect(box.credentials).toEqual([{ node: "coder.fleet-node-1", issued: true }]);
    expect(io.output()).toContain("✓ The hub, coder.fleet-hub, took coder.fleet-node-1");
  });

  test("fleet devbox add refuses a name the hub cannot use, or a pool box name, before it saves or publishes anything", async () => {
    const { home, io, add } = await withHub();
    const before = await pushedAnswers(home);
    for (const host of ["worker_1", "Node-1", "box-7"]) {
      const box = fakeMachine(home);
      expect(await add(host, box)).toBe(2);
      expect(remote(box)).toEqual([]);
    }
    expect(io.output()).toContain("fleet devbox: worker_1 is not a name the hub can use. Give the devbox an SSH name in ~/.ssh/config of lowercase letters, digits, dots and dashes, starting with a letter or a digit.");
    expect(io.output()).toContain("fleet devbox: Node-1 is not a name the hub can use.");
    expect(io.output()).toContain("fleet devbox: box-7 is a pool box name. Names that start with box- are kept for the boxes the hub starts; give the devbox another SSH name.");
    expect(await pushedAnswers(home)).toEqual(before);
    expect(machineFile(home).devboxes).toEqual([]);
  });

  test("fleet devbox add names the box by the SSH name the profile lists, keeps the rest of a role file there, and stops when the box already has another name", async () => {
    const { home, io, add } = await withHub();
    expect(await add("coder.fleet-node-1", fakeMachine(home))).toBe(0);
    expect(boxMachineFile(home, "coder.fleet-node-1")).toEqual({ schema: 1, role: "devbox", name: "coder.fleet-node-1" });

    const unnamed = join(boxHome(home, "node-2"), ".config/fleet");
    mkdirSync(unnamed, { recursive: true });
    writeFileSync(join(unnamed, "machine.json"), JSON.stringify({ schema: 1, role: "linux", coder: true }));
    expect(await add("node-2", fakeMachine(home))).toBe(0);
    expect(boxMachineFile(home, "node-2")).toEqual({ schema: 1, role: "linux", coder: true, name: "node-2" });

    const named = join(boxHome(home, "node-3"), ".config/fleet");
    mkdirSync(named, { recursive: true });
    writeFileSync(join(named, "machine.json"), JSON.stringify({ schema: 1, role: "devbox", name: "old-node" }));
    const box = fakeMachine(home);
    expect(await add("node-3", box)).toBe(1);
    expect(io.output()).toContain("fleet: node-3 already calls itself old-node in ~/.config/fleet/machine.json. Run fleet devbox add old-node to keep that name, or set its name there to node-3 and run fleet devbox add node-3 again.");
    expect(boxMachineFile(home, "node-3").name).toBe("old-node");
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.fleet-node-1", "node-2"]);
    expect(box.hubUpdates).toEqual([]);
  });

  test("fleet devbox add reads the box's role file and T3 Connect state apart from the host key warning ssh prints when it first reaches the box", async () => {
    const { home, add } = await withHub();
    const folder = join(boxHome(home, "node-4"), ".config/fleet");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "machine.json"), JSON.stringify({ schema: 1, role: "linux" }));
    const box = fakeMachine(home, { "box:t3": 1 });
    expect(await add("node-4", box)).toBe(0);
    expect(boxMachineFile(home, "node-4")).toEqual({ schema: 1, role: "linux", name: "node-4" });
    expect(machineFile(home).setup.done).toContain("devbox:node-4:link");
  });

  test("fleet devbox add for the hub itself lists it once and asks nothing of a hub", async () => {
    const { home, add } = await withHub();
    const box = fakeMachine(home);
    expect(await add("coder.fleet-hub", box)).toBe(0);
    expect(await add("coder.fleet-hub", box)).toBe(0);
    expect((await pushedAnswers(home)).devboxes).toEqual(["coder.fleet-hub"]);
    expect(box.hubUpdates).toEqual([]);
    expect(box.hubLinked).toEqual([]);
  });
});
