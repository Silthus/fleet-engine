import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";
import type { CommandRunner } from "../adapters/run.ts";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { engineRoot, fakeMachine, fleetSetup, scripted } from "../setup/testing.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const spell = (alphabet: string, length: number, start: number) => Array.from({ length }, (_, index) => alphabet[(start + index * 11) % alphabet.length]).join("");
const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const mixed = `${letters}23456789`;
const capitals = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const lowers = "abcdefghijkmnopqrstuvwxyz";
const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ234567";

/** Secrets in the shapes real services issue, built at run time so no real-looking secret is in the repository. */
function secrets() {
  return {
    github: ["gh", "p_", spell(mixed, 36, 1)].join(""),
    githubPat: ["github", "_pat_", spell(mixed, 22, 2), "_", spell(mixed, 59, 3)].join(""),
    anthropic: ["sk", "-ant-api03-", spell(mixed, 90, 4)].join(""),
    openai: ["sk", "-proj-", spell(mixed, 48, 5)].join(""),
    slack: ["xo", "xb-", spell("0123456789", 12, 6), "-", spell(mixed, 24, 7)].join(""),
    aws: ["AK", "IA", spell(upper, 16, 8)].join(""),
    jwt: ["ey", "J", spell(mixed, 20, 9), ".", spell(mixed, 30, 10), ".", spell(mixed, 30, 11)].join(""),
    opaque: spell(mixed, 44, 12),
    opaqueLetters: spell(letters, 44, 13),
    cachedLetters: spell(letters, 44, 20),
    splitLetters: [spell(letters, 22, 21), "-", spell(letters, 21, 22)].join(""),
    containedLetters: spell(letters, 32, 23),
    containedSplit: [spell(letters, 16, 24), "-", spell(letters, 16, 25)].join(""),
    unevenSplit: [spell(capitals, 13, 26), spell(lowers, 4, 27), "_", spell(capitals, 3, 28), spell(lowers, 13, 29), "=="].join(""),
    padded: [spell(capitals, 8, 30), spell(lowers, 24, 31), "=="].join(""),
    longPart: [spell(capitals, 97, 32), spell(lowers, 31, 33), "_", spell(letters, 16, 34)].join(""),
    longLowerPart: [spell(lowers, 97, 35), spell(capitals, 31, 36), "_", spell(letters, 16, 37)].join(""),
    password: spell(mixed, 14, 14),
    privateKey: ["-----BEGIN OPENSSH ", "PRIVATE KEY-----\n", spell(mixed, 64, 15).match(/.{16}/g)!.join("\n"), "\n-----END OPENSSH ", "PRIVATE KEY-----"].join(""),
    multiline: [spell(mixed, 10, 16), " river\npearl ", spell(mixed, 10, 17)].join(""),
    email: ["nora.", spell("abcdefgh", 5, 18), "@", "example-corp.io"].join(""),
  };
}

/** Each line of each secret, without the markers around a private key. */
const secretParts = (leaked: ReturnType<typeof secrets>) => Object.values(leaked).flatMap((secret) => secret.split("\n")).filter((line) => !line.startsWith("-----")).map((line) => line.replace(/^(?:pearl | river)/, ""));

type Sent = { command: string[]; input?: string };

function capture(sent: Sent[], gh: { code: number; stdout: string; stderr?: string } = { code: 0, stdout: "https://github.com/Silthus/fleet-engine/issues/999\n" }): CommandRunner {
  const versions: Record<string, string> = { t3: "t3 0.0.42\n", claude: "2.1.300 (Claude Code)\n", codex: "codex-cli 0.170.0\n", gh: "gh version 2.80.0 (2026-10-01)\nhttps://github.com/cli/cli/releases/tag/v2.80.0\n" };
  return async (command, options = {}) => {
    sent.push({ command, ...(options.input === undefined ? {} : { input: options.input }) });
    if (command[0] === "gh" && command[1] === "issue") return gh;
    if (command[0] === "git" && command.includes("user.name")) return { code: 0, stdout: "Nora Quill\n" };
    if (command[0] === "git" && command.includes("describe")) return { code: 0, stdout: "v1.4.0-3-gabc1234\n" };
    if (command[0] === "git" && command.includes("get-url")) return { code: 0, stdout: "https://github.com/nora/team-dotfiles.git\n" };
    const version = versions[command[0]!];
    return version ? { code: 0, stdout: version } : { code: 1, stdout: "", stderr: "not found" };
  };
}

/** A machine whose last setup failed, with secrets and private names in its transcript and errors. */
function failedMachine(home: string, leaked = secrets()) {
  const profileDir = join(home, "profile");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "v1", channel: "release" }, sources: [{ name: "team", repo: "secret-org/team-packs", ref: "main" }], packs: ["pull-requests", "team"], plan: "both", settings: { "memory.repo": "nora/agent-notes" }, workflows: {}, hub: "hub-big-box", devboxes: ["node-west-7"] }));
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "mac", name: "noras-mbp", profileDir, devboxes: ["node-west-7", "q7"], setup: { done: ["bootstrap", "github", "packs"] } }));
  const state = join(home, ".local/state/fleet/logs");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "setup.log"),
    [
      "=== fleet setup at 2026-11-11T10:00:00.000Z",
      "Fleet setup · 4 of 8 · about 6 min left",
      "▶ Set up this Mac: fleet apply installs your packs",
      `  export GITHUB_TOKEN=${leaked.github}`,
      `  Authorization: Bearer ${leaked.jwt}`,
      `  ANTHROPIC_API_KEY="${leaked.anthropic}"`,
      `  OPENAI_API_KEY: ${leaked.openai}`,
      `  pat ${leaked.githubPat} slack ${leaked.slack} aws ${leaked.aws}`,
      `  opaque ${leaked.opaque} and ${leaked.opaqueLetters} in a log`,
      "  tapped /opt/homebrew/Library/Taps/homebrew/homebrew-core for AbstractSingletonProxyFactoryBean",
      `  cached /opt/homebrew/var/lib/someservice/sessions/cache/storage/tokens/current/${leaked.cachedLetters}`,
      `  refresh ${leaked.splitLetters} and FLEET_ENGINE_DIR/scripts/build-page-and-site`,
      `  kept /Library/Application/Containers/Preferences/Caches/Storage/Sessions/Current/${leaked.containedLetters}`,
      `  kept /Library/Application/Containers/Preferences/Caches/Storage/Sessions/Current/${leaked.containedSplit}`,
      `  refresh ${leaked.unevenSplit} done, then ${leaked.longPart}`,
      `  kept /Library/Application/Containers/Preferences/Caches/Storage/Sessions/Current/${leaked.unevenSplit} and ${leaked.padded}`,
      `  kept /Library/Application/Containers/Preferences/Caches/Storage/Sessions/Current/${leaked.longLowerPart}`,
      `  cloning https://nora:${leaked.password}@github.com/nora/fleet-profile.git`,
      `  Pairing URL: http://127.0.0.1:3773/pair#token=${leaked.password}`,
      leaked.privateKey,
      `  PASSWORD="${leaked.multiline}"`,
      "  mailto first%2Elast%40mail%2Eexample%2Ecom and git@example.com, cloned git@github.com:acme/tools.git",
      "  read /Users/Taylor Smith/.ssh/config and C:\\Users\\Taylor Smith\\.ssh\\id_ed25519",
      `  author ${leaked.email} at noras-mbp.local, Nora Quill`,
      `  ssh node-west-7.corp.internal (10.20.30.40) fleet doctor`,
      `  {"password":"${leaked.password} horse, battery staple"} and {'client_secret': '${leaked.opaque.slice(0, 12)}'}`,
      `  invited ${leaked.email.replace("@", "%40")} as Nora%20Quill and Nora+Quill, then ssh q7 true (Q7 stays)`,
      `  read C:\\Users\\NoraQ\\.ssh\\id_ed25519 and C:\\Users\\NoraQ\\.gitconfig`,
      "  pushed nora/team-dotfiles and cloned nora/agent-notes",
      "  Created the private repo nora/fleet-profile",
      `  wrote ${home}/.claude/settings.json and /Users/nora/.zshrc`,
      "  fetched secret-org/team-packs at main",
      "  engine at 0123456789abcdef0123456789abcdef01234567",
      "fleet doctor: Everything matches. engine 0123456789abcdef0123456789abcdef01234567 v1.4.0 at git@github.com:nora/fleet-profile.git",
      "  - Token scopes: 'repo', 'read:org'",
      "fleet: fleet apply could not set up this machine. Fix what it says above, then run fleet setup again.",
    ].join("\n") + "\n",
  );
  writeFileSync(join(state, "setup-failed.json"), JSON.stringify({ at: "2026-11-11T10:03:00.000Z", step: "4 of 8: Set up this Mac", error: `fleet apply could not set up this machine on noras-mbp for ${leaked.email}.` }));
  return leaked;
}

async function triage(home: string, args: string[], replies: string[], sent: Sent[] = [], gh?: Parameters<typeof capture>[1]) {
  const io = scripted(replies);
  const code = await main(["triage", ...args], { home, engineRoot, platform: "darwin", env: {}, print: io.terminal.print, terminal: io.terminal, capture: capture(sent, gh), hostname: () => "noras-mbp.local", run: async () => 0 });
  return { code, output: io.output(), prompts: io.prompts, sent };
}

const savedReports = (home: string) => readdirSync(home).filter((name) => name.startsWith("fleet-triage-"));

describe("fleet triage", () => {
  test("shows what went wrong, the failed step, versions, doctor and the transcript, with every secret and name removed, and saves it on ↵", async () => {
    const home = temp.make("home-");
    const leaked = failedMachine(home);
    const result = await triage(home, [], ["setup hangs at step 4", ""]);
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual(["What went wrong, in a few words? Press ↵ to skip: ", "Press ↵ to save it, or type a number: "]);
    const shown = result.output;
    expect(shown).toContain("# fleet triage: setup hangs at step 4");
    expect(shown).toContain("## What happened\n\nsetup hangs at step 4");
    expect(shown).toContain("- Role: mac");
    expect(shown).toContain("- Steps done: bootstrap, github, packs");
    expect(shown).toContain("- Failed at 2026-11-11T10:03:00.000Z, 4 of 8: Set up this Mac: fleet apply could not set up this machine on <this machine> for <email>.");
    expect(shown).toContain("- Engine: v1.4.0-3-gabc1234");
    expect(shown).toContain("- Profile engine pin: Silthus/fleet-engine@v1 (release)");
    expect(shown).toContain("- Packs: pull-requests, team; plan both");
    expect(shown).toContain("- T3 Code: t3 0.0.42");
    expect(shown).toContain("- Claude Code: 2.1.300 (Claude Code)");
    expect(shown).toContain("- Codex: codex-cli 0.170.0");
    expect(shown).toContain("- gh: gh version 2.80.0 (2026-10-01)");
    expect(shown).toContain(`- Bun: ${Bun.version}`);
    expect(shown).toContain("- OS: not found (darwin ");
    expect(shown).toContain("## fleet doctor\n\n```text\nfleet: ");
    expect(shown).toContain("▶ Set up this Mac: fleet apply installs your packs");
    expect(shown).toContain("export GITHUB_TOKEN=<redacted>");
    expect(shown).toContain("opaque <secret> and <secret> in a log");
    expect(shown).toContain("tapped /opt/homebrew/Library/Taps/homebrew/homebrew-core for AbstractSingletonProxyFactoryBean");
    expect(shown).toContain("refresh <secret> and FLEET_ENGINE_DIR/scripts/build-page-and-site");
    expect(shown).toContain("https://<credentials>@github.com/<profile repo>.git");
    expect(shown).toContain(`{"password":"<redacted>"} and {'client_secret': '<redacted>'}`);
    expect(shown).toContain("invited <email> as <name> and <name>, then ssh <devbox 2> true (Q7 stays)");
    expect(shown).toContain("read C:\\Users\\<user>\\.ssh\\id_ed25519 and C:\\Users\\<user>\\.gitconfig");
    expect(shown).toContain("pushed <profile repo> and cloned <private repo>");
    expect(shown).toContain("Created the private repo <profile repo>");
    expect(shown).toContain("fleet doctor: Everything matches. engine 0123456789abcdef0123456789abcdef01234567 v1.4.0 at git@github.com:<profile repo>.git");
    expect(shown).toContain("ssh <devbox 1>.<host> (<ip>) fleet doctor");
    expect(shown).toContain("wrote ~/.claude/settings.json and /Users/<user>/.zshrc");
    expect(shown).toContain("<private key>\n  PASSWORD=\"<redacted>\"\n");
    expect(shown).toContain("mailto <email> and <email>, cloned git@github.com:acme/tools.git");
    expect(shown).toContain("read /Users/<user>/.ssh/config and C:\\Users\\<user>\\.ssh\\id_ed25519");
    expect(shown).toContain("fetched <team source> at main");
    expect(shown).toContain("at <this machine>, <name>");
    expect(shown).toContain("engine at 0123456789abcdef0123456789abcdef01234567");
    expect(shown).toContain("- Token scopes: 'repo', 'read:org'");
    expect(shown).toContain("Fleet removed tokens, keys, email addresses, hostnames and home paths from this report.");
    const report = shown.slice(0, shown.indexOf("Send this report"));
    for (const part of secretParts(leaked)) expect(report).not.toContain(part);
    for (const name of ["noras-mbp", "node-west-7", "hub-big-box", "10.20.30.40", "secret-org", "Nora Quill", "Nora%20Quill", "NoraQ", "horse", "Taylor", "Smith", "first", "mail%2E", "example.com", "team-dotfiles", "agent-notes", leaked.opaque.slice(0, 12), home]) expect(report).not.toContain(name);

    const [file] = savedReports(home);
    expect(shown).toContain(`✓ Saved the report to ${join(home, file!)}.`);
    const saved = readFileSync(join(home, file!), "utf8");
    expect(saved).toStartWith("# fleet triage: setup hangs at step 4\n\n## What happened");
    for (const part of secretParts(leaked)) expect(saved).not.toContain(part);
    expect(saved).not.toContain(home);
    expect(result.sent.some((call) => call.command[1] === "issue")).toBe(false);
  });

  test("with 1, opens a public issue on the engine repo, with the shown report on gh's standard input", async () => {
    const home = temp.make("home-");
    const leaked = failedMachine(home);
    const result = await triage(home, [], ["", "1"]);
    expect(result.code).toBe(0);
    const issue = result.sent.find((call) => call.command[1] === "issue")!;
    expect(issue.command).toEqual(["gh", "issue", "create", "--repo", "Silthus/fleet-engine", "--title", "fleet triage: setup failed: fleet apply could not set up this machine on <this machine> for <email>.", "--body-file", "-"]);
    expect(issue.input).toStartWith("## What happened\n\nNot described.\n\n## Setup");
    expect(result.output).toContain(issue.input!.split("\n").slice(0, 12).join("\n"));
    for (const part of secretParts(leaked)) expect(issue.input).not.toContain(part);
    expect(result.output).toEndWith("✓ Opened https://github.com/Silthus/fleet-engine/issues/999");
    expect(savedReports(home)).toEqual([]);
  });

  test("names what setup saved before a profile exists: the machine name, draft sources, and the repos it created", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "mac", name: "ssh-silver-fox", setup: { done: ["bootstrap", "github"], draft: { sources: [{ name: "acme", repo: "acme/private-packs", ref: "main" }], settings: { "orchestration.ledgerRepo": "acme/loop-ledger" } } } }));
    mkdirSync(join(home, ".local/state/fleet/logs"), { recursive: true });
    writeFileSync(join(home, ".local/state/fleet/logs/setup.log"), "  on ssh-silver-fox: fetched acme/private-packs, ledger acme/loop-ledger\n  ✓ Created the private repo acme/fleet-memory\n  Fleet creates the private repos acme/one and acme/two in your account\n");
    writeFileSync(join(home, ".local/state/fleet/logs/setup-failed.json"), JSON.stringify({ at: "2026-11-11T10:03:00.000Z", error: "could not push acme/private-packs from ssh-silver-fox" }));
    const result = await triage(home, ["--send"], []);
    const issue = result.sent.find((call) => call.command[1] === "issue")!;
    expect(issue.command[6]).toBe("fleet triage: setup failed: could not push <acme source> from <this machine>");
    expect(issue.input).toContain("  on <this machine>: fetched <acme source>, ledger <private repo>\n  ✓ Created the private repo <memory repo>\n  Fleet creates the private repos <private repo> in your account\n");
    for (const name of ["silver-fox", "private-packs", "loop-ledger", "acme/"]) expect(`${issue.command[6]}\n${issue.input}`).not.toContain(name);
  });

  test("a long title is cut after redaction, so no part of a secret reaches the issue", async () => {
    const home = temp.make("home-");
    const { email } = failedMachine(home);
    const result = await triage(home, ["--send", "--note", `${"y".repeat(90)} ${email} could not sign in`], []);
    const title = result.sent.find((call) => call.command[1] === "issue")!.command[6]!;
    expect(title).toStartWith(`fleet triage: ${"y".repeat(90)} <email> could …`);
    expect(title).not.toContain(email.split("@")[0]!);
  });

  test("when gh cannot open the issue, saves the report and names the page to paste it into", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const result = await triage(home, ["--send"], [], [], { code: 4, stdout: "", stderr: `To get started with GitHub CLI, please run:  gh auth login\nnot logged in at ${home} on noras-mbp as Nora Quill for secret-org/team-packs\n` });
    expect(result.code).toBe(1);
    expect(result.prompts).toEqual([]);
    expect(result.output).toContain("Could not open the issue: not logged in at ~ on <this machine> as <name> for <team source>");
    const [file] = savedReports(home);
    expect(result.output).toEndWith(`Saved the report to ${join(home, file!)}. Open https://github.com/Silthus/fleet-engine/issues/new and paste it there.`);
  });

  test("3 sends and saves nothing, --print only shows, and Ctrl-C stops without sending", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const neither = await triage(home, [], ["", "7", "3"]);
    expect(neither).toMatchObject({ code: 0 });
    expect(neither.output).toEndWith("Nothing was sent or saved.");
    const printed = await triage(home, ["--print", "--note", "agent asked"], []);
    expect(printed.code).toBe(0);
    expect(printed.prompts).toEqual([]);
    expect(printed.output).toContain("# fleet triage: agent asked");
    const stopped = await triage(home, [], [""]);
    expect(stopped.code).toBe(130);
    expect(stopped.output).toEndWith("Stopped. Nothing was sent.");
    expect(savedReports(home)).toEqual([]);
    expect([...neither.sent, ...printed.sent, ...stopped.sent].some((call) => call.command[1] === "issue")).toBe(false);
  });

  test("--save writes the report to the named file, and two modes at once are refused", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const path = join(home, "report.md");
    expect((await triage(home, ["--save", path], [])).code).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("## Setup transcript");
    const both = await triage(home, ["--print", "--send"], []);
    expect(both.code).toBe(2);
    expect(both.output).toBe("fleet triage: pick one of --print, --save and --send");
  });

  test("on a machine without setup, says what it lacks instead of failing", async () => {
    const home = temp.make("home-");
    const result = await triage(home, ["--print"], []);
    expect(result.code).toBe(0);
    expect(result.output).toContain("- No machine file: fleet setup has not saved progress on this machine.");
    expect(result.output).toContain("- No failed setup run is recorded.");
    expect(result.output).toContain("- No setup timings recorded.");
    expect(result.output).toContain("- Profile engine pin: no profile");
    expect(result.output).toContain("fleet: no profile on this machine.");
    expect(result.output).toContain("No setup transcript on this machine.");
  });

  test("shows the setup timings and t_usable when setup wrote them", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const steps = [
      { id: "github", title: "Sign in to GitHub", start: "2026-11-11T10:00:05.000Z", end: "2026-11-11T10:01:10.000Z", blocked: true, outcome: "done" },
      { id: "apply", title: "Set up | this Mac", start: "2026-11-11T10:01:10.000Z", end: "2026-11-11T10:03:00.000Z", blocked: false, outcome: "failed", error: "exit 1" },
      { id: "check", start: "2026-11-11T10:03:00.000Z" },
    ];
    writeFileSync(join(home, ".local/state/fleet/logs/setup-timings.json"), JSON.stringify({ schema: 1, started: "2026-11-11T10:00:00.000Z", usable: "2026-11-11T10:04:12.000Z", steps }));
    const result = await triage(home, ["--print"], []);
    expect(result.output).toContain(["- t_usable: 4m 12s", "", "| Step | Took | Waited on you | Result |", "| --- | --- | --- | --- |", "| Sign in to GitHub | 1m 5s | yes | done |", "| Set up \\| this Mac | 1m 50s | no | failed: exit 1 |", "| check | still running | no |  |"].join("\n"));
  });

  test("before setup reaches t_usable, shows the steps it timed and no t_usable", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const github = { id: "github", title: "Sign in to GitHub", kind: "human", start: "2026-11-11T10:00:05.000Z", end: "2026-11-11T10:00:47.000Z", seconds: 42, blocked: true, outcome: "done" };
    writeFileSync(join(home, ".local/state/fleet/logs/setup-timings.json"), JSON.stringify({ schema: 1, started: "2026-11-11T10:00:00.000Z", usable: null, usableSeconds: null, blockedSteps: 1, steps: [github] }));
    const result = await triage(home, ["--print"], []);
    expect(result.output).toContain("- Failed at 2026-11-11T10:03:00.000Z, 4 of 8: Set up this Mac: fleet apply could not set up this machine on <this machine> for <email>.\n\n| Step | Took | Waited on you | Result |");
    expect(result.output).toContain("| Sign in to GitHub | 42s | yes | done |");
    expect(result.output).not.toContain("t_usable");
  });

  test("keeps a long transcript under GitHub's issue size by cutting its oldest lines", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    const state = join(home, ".local/state/fleet/logs");
    writeFileSync(join(state, "setup.log"), Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(200)}`).join("\n"));
    const result = await triage(home, ["--send"], []);
    const body = result.sent.find((call) => call.command[1] === "issue")!.input!;
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toMatch(/## Setup transcript \(newest \d+ lines\)\n\n```text\nline \d+ x/);
    expect(body).toContain("line 399 ");
    expect(body).not.toContain("line 0 ");
    expect(body).toEndWith("Made by `fleet triage`.");
  });

  test("a huge dotted transcript line still gives a report that fits", async () => {
    const home = temp.make("home-");
    failedMachine(home);
    writeFileSync(join(home, ".local/state/fleet/logs/setup.log"), `${"a.".repeat(1_048_576)}\nthe newest line\n`);
    const result = await triage(home, ["--send"], []);
    const body = result.sent.find((call) => call.command[1] === "issue")!.input!;
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("## Setup transcript (newest 1 lines)\n\n```text\nthe newest line\n```\n\nMade by `fleet triage`.");
    expect(body).toContain("## fleet doctor");
  }, 2_000);
});

describe("fleet setup and triage", () => {
  test("a failed step records the transcript and the step, and its message names fleet triage", async () => {
    const home = temp.make("home-");
    const args = ["--non-interactive", "--preset", "starter", "--plan", "claude"];
    const failed = await fleetSetup(home, args, [], fakeMachine(home), undefined, 1);
    expect(failed.code).toBe(1);
    expect(failed.output).toEndWith("fleet: fleet doctor found something to fix on this machine. Fix what it says above, then run fleet setup again.\nStuck? Run fleet triage. It shows a report of this setup that you can send to the Fleet maintainer.");
    expect(statSync(join(home, ".local/state/fleet/logs")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, ".local/state/fleet/logs/setup.log")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".local/state/fleet/logs/setup-failed.json")).mode & 0o777).toBe(0o600);
    const report = await triage(home, ["--print"], []);
    expect(report.output).toMatch(/- Failed at \S+, 9 of 9: Check everything: fleet doctor found something to fix on this machine\./);
    expect(report.output).toContain("=== fleet setup --non-interactive --preset starter --plan claude at ");
    expect(report.output).toContain("✗ fleet doctor found something to fix on this machine.");

    const passed = await fleetSetup(home, args, [], fakeMachine(home));
    expect(passed.code).toBe(0);
    expect(passed.output).toContain("  Report          fleet triage sends a report of this setup to the Fleet maintainer.");
    expect(existsSync(join(home, ".local/state/fleet/logs/setup-failed.json"))).toBe(false);
    const after = await triage(home, ["--print"], []);
    expect(after.output).toContain("- No failed setup run is recorded.");
    expect(after.output).toContain("Welcome back. 8 of 9 done, picking up at Check everything.");
  });

  test("makes records that an earlier run left readable to others private", async () => {
    const home = temp.make("home-");
    const logs = join(home, ".local/state/fleet/logs");
    mkdirSync(logs, { recursive: true, mode: 0o755 });
    writeFileSync(join(logs, "setup.log"), "an earlier run\n", { mode: 0o644 });
    await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home));
    expect(statSync(logs).mode & 0o777).toBe(0o700);
    expect(statSync(join(logs, "setup.log")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(logs, "setup.log"), "utf8")).toStartWith("an earlier run\n=== fleet setup ");
  });

  test("setup goes on when it cannot write its records", async () => {
    const home = temp.make("home-");
    mkdirSync(join(home, ".local"), { recursive: true });
    writeFileSync(join(home, ".local/state"), "a file where Fleet's state folder goes");
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude"], [], fakeMachine(home), undefined, 1);
    expect(result.code).toBe(1);
    expect(result.output).toContain("▶ Check everything");
    expect(result.output).toEndWith("Stuck? Run fleet triage. It shows a report of this setup that you can send to the Fleet maintainer.");
  });

});
