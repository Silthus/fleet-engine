import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { main } from "../cli.ts";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { overSsh, pairing, profileForBox, sshHosts } from "./devbox.ts";
import { engineRoot, fakeMachine, fleetSetup, githubRepo, machineFile, onBox, pushedAnswers, scripted } from "./testing.ts";

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
    expect(pushedAnswers(home).settings["orchestration.loopProject"]).toBe("~/code/app");

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
    expect(pushedAnswers(home).settings["orchestration.loopProject"]).toBe("~/code/app");
  });

  test("fleet devbox add makes a host a devbox later, and a failed install stops with what to do", async () => {
    const home = temp.make("home-");
    expect((await fleetSetup(home, ["--preset", "starter", "--plan", "claude"], ["", ""])).code).toBe(0);
    const failing = fakeMachine(home, {}, { failRun: true });
    const io = scripted([]);
    const options = { home, engineRoot, platform: "linux" as const, print: io.terminal.print, terminal: io.terminal };
    expect(await main(["devbox", "add", "box-2"], { ...options, setup: { machine: failing.machine } })).toBe(1);
    expect(io.output()).toContain("fleet: Fleet did not install on the devbox. Fix what it says above, then run fleet setup again.");

    const box = fakeMachine(home);
    expect(await main(["devbox", "add", "box-2"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toEndWith("box-2 is your devbox now. It runs your profile, and T3 Code here and there can reach each other.");
    expect(machineFile(home).devboxes).toEqual(["box-2"]);
    expect(machineFile(home).setup.done).toContain("devbox:box-2:link");

    expect(await main(["devbox"], { ...options, setup: { machine: box.machine } })).toBe(0);
    expect(io.output()).toContain("Your devboxes: box-2");
    expect(await main(["devbox", "remove", "box-2"], options)).toBe(2);
    expect(await main(["devbox", "add", "-oProxyCommand=x"], options)).toBe(2);
    expect((await fleetSetup(temp.make("home-"), ["--devbox", "-oProxyCommand=x"])).output).toStartWith("fleet setup: --devbox takes an SSH host");
  });
});
