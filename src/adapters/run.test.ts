import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "../pack/types.ts";
import { apply } from "../reconciler/apply.ts";
import { tempDirs } from "../testing/git.ts";
import { identityAdapter } from "./identity/adapter.ts";
import { jobsAdapter } from "./jobs/adapter.ts";
import { accountHome, directoryHome, passwdHome, spawnRunner, type CommandRunner } from "./run.ts";
import { t3Adapter } from "./t3/adapter.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

describe("the command runner", () => {
  test("runs with the given HOME and without the variables it is told to clear", async () => {
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/elsewhere";
    try {
      const shown = await spawnRunner(["sh", "-c", 'printf "%s %s" "$HOME" "${CLAUDE_CONFIG_DIR-unset}"'], { home: "/tmp/fleet-home", clearEnv: ["CLAUDE_CONFIG_DIR"] });
      expect(shown.stdout).toBe("/tmp/fleet-home unset");
      expect((await spawnRunner(["sh", "-c", 'printf %s "$CLAUDE_CONFIG_DIR"'])).stdout).toBe("/elsewhere");
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

});

describe("account home lookup", () => {
  const passwd = ["root:x:0:0:root:/root:/bin/bash", "DOMAIN\\octo:x:1000:1000:Octo Cat,,,:/home/DOMAIN\\octo:/bin/zsh", "broken:x:1001", "relative:x:1002:1002::home/relative:/bin/sh", ""].join("\n");

  test("reads the home folder of a uid from passwd lines, whatever the login name holds", () => {
    expect(passwdHome(passwd, 1000)).toBe("/home/DOMAIN\\octo");
    expect(passwdHome(passwd, 0)).toBe("/root");
  });

  test("finds no home for an unknown uid, a short line, or a relative folder", () => {
    expect(passwdHome(passwd, 4242)).toBeUndefined();
    expect(passwdHome(passwd, 1001)).toBeUndefined();
    expect(passwdHome(passwd, 1002)).toBeUndefined();
    expect(passwdHome("", 1000)).toBeUndefined();
  });

  test("reads the home folder from the Mac directory service answer", () => {
    expect(directoryHome("name: octo\npassword: ********\nuid: 501\ngid: 20\ndir: /Users/octo\nshell: /bin/zsh\ngecos: Octo Cat\n\n")).toBe("/Users/octo");
    expect(directoryHome("")).toBeUndefined();
    expect(directoryHome("dir: Users/octo\n")).toBeUndefined();
  });

  test("asks getent for the uid's line and reads a backslash login's home from it", () => {
    const asked: string[][] = [];
    const sources = { platform: "linux" as const, exists: (path: string) => path === "/usr/bin/getent", file: () => "", output: (command: string[]) => (asked.push(command), passwd.split("\n")[1]!) };
    expect(accountHome(1000, sources)).toBe("/home/DOMAIN\\octo");
    expect(asked).toEqual([["/usr/bin/getent", "passwd", "1000"]]);
  });

  test("falls back to /etc/passwd when getent is missing", () => {
    const sources = { platform: "linux" as const, exists: () => false, file: (path: string) => (path === "/etc/passwd" ? passwd : ""), output: () => "" };
    expect(accountHome(1000, sources)).toBe("/home/DOMAIN\\octo");
    expect(accountHome(4242, sources)).toBeUndefined();
  });

  test("asks the Mac directory service for the uid", () => {
    const sources = { platform: "darwin" as const, exists: () => true, file: () => "", output: (command: string[]) => (command.join(" ") === "/usr/bin/dscacheutil -q user -a uid 501" ? "name: octo\ndir: /Users/octo\n" : "") };
    expect(accountHome(501, sources)).toBe("/Users/octo");
  });

  test("on a Mac, falls back to /etc/passwd when dscacheutil is missing or knows no home, and never asks getent", () => {
    const macPasswd = "_spotlight:*:89:89:Spotlight:/var/empty:/usr/bin/false\nocto:*:501:20:Octo Cat:/Users/octo:/bin/zsh\n";
    const asked: string[][] = [];
    const missing = { platform: "darwin" as const, exists: () => false, file: (path: string) => (path === "/etc/passwd" ? macPasswd : ""), output: (command: string[]) => (asked.push(command), "") };
    expect(accountHome(501, missing)).toBe("/Users/octo");
    expect(asked).toEqual([]);
    const silent = { ...missing, exists: (path: string) => path === "/usr/bin/dscacheutil" || path === "/usr/bin/getent" };
    expect(accountHome(501, silent)).toBe("/Users/octo");
    expect(asked).toEqual([["/usr/bin/dscacheutil", "-q", "user", "-a", "uid", "501"]]);
    expect(accountHome(4242, silent)).toBeUndefined();
  });

  test.if(process.platform === "linux")("finds the exact account home even when HOME and PATH point elsewhere", () => {
    const uid = process.getuid!();
    const expected = readFileSync("/etc/passwd", "utf8").split("\n").map((line) => line.split(":")).find((fields) => fields[2] === String(uid))?.[5] ?? Bun.spawnSync(["getent", "passwd", String(uid)]).stdout.toString().split(":")[5];
    const home = temp.make("home-");
    const script = `import { accountHome } from ${JSON.stringify(join(import.meta.dir, "run.ts"))}; console.log(JSON.stringify(accountHome() ?? null));`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { env: { HOME: home, PATH: "" } });
    expect(JSON.parse(child.stdout.toString())).toBe(expected!);
  });
});

function plan(): Plan {
  return {
    machine: { schema: 1, role: "devbox" },
    os: "linux",
    ai: "both",
    packs: [{ name: "base", source: "engine", ref: "main", available: true }],
    workflows: [],
    files: [],
    config: [],
    owners: {},
    jobs: [{ id: "skills-pull", pack: "base", command: ["git", "pull"], schedule: { every: "5m" } }],
    human: [],
    steps: [],
    checks: [],
    commands: {},
    handlers: {},
    settings: {},
    unanswered: [],
    ask: [],
    dropped: [],
    models: [],
  };
}

const quietServer = { answering: async () => false, session: async () => Promise.reject(new Error("no server")) };

describe.each([
  ["jobs", "your scheduled jobs", (run: CommandRunner, accountHome: () => string | undefined) => jobsAdapter({ run, accountHome, engineRoot: "/opt/fleet-engine" })],
  ["identity", "your git identity", (run: CommandRunner, accountHome: () => string | undefined) => identityAdapter({ run, accountHome, engineRoot: "/opt/fleet-engine", hostname: "devbox" })],
  ["t3", "T3 Code", (run: CommandRunner, accountHome: () => string | undefined) => t3Adapter({ run, accountHome, server: quietServer, user: "octo" })],
] as const)("the %s adapter's home guard", (name, what, make) => {
  const recorder = () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (command) => (calls.push(command), { code: 1, stdout: "" });
    return { calls, run };
  };

  test("reports a finding and runs nothing when the account home cannot be looked up", async () => {
    const home = temp.make("home-");
    const { calls, run } = recorder();
    const report = await apply(plan(), { home, adapters: [make(run, () => undefined)] });
    expect(calls).toEqual([]);
    expect(report.findings).toEqual([
      {
        id: `${name}:home`,
        pack: "engine",
        say: `Fleet left ${what} alone: it could not look up your account's home folder, so it cannot tell whether ${home} is yours. Check that your system lists your user (getent passwd on Linux, dscacheutil on a Mac), then run fleet apply.`,
        repair: "human",
      },
    ]);
  });

  test("runs nothing and reports nothing for a home that is not the account's", async () => {
    const home = temp.make("home-");
    const { calls, run } = recorder();
    const report = await apply(plan(), { home, adapters: [make(run, () => "/home/someone-else")] });
    expect(calls).toEqual([]);
    expect(report).toMatchObject({ actions: [], findings: [] });
  });

  test("reconciles the account's own home", async () => {
    const home = temp.make("home-");
    const { calls, run } = recorder();
    await apply(plan(), { home, adapters: [make(run, () => `${home}/`)] });
    expect(calls.length).toBeGreaterThan(0);
  });
});
