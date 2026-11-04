import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { proofCommand, type ProofContext } from "./proof-cli.ts";
import { standingFor } from "./proof.ts";
import type { ThreadWord } from "./proof-answers.ts";

const command = resolve(dirname(fileURLToPath(import.meta.url)), "../commands/proof.ts");
const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(directory);
  return directory;
}

function checkout() {
  const directory = fixture("fleet-proof-checkout-");
  const [home, repository, bin] = ["home", "repository", "bin"].map((name) => join(directory, name));
  for (const path of [home, repository, bin]) mkdirSync(path);
  writeFileSync(join(bin, "gh"), `#!/bin/sh
printf '{"number":42,"url":"https://github.com/example/product/pull/42","baseRefName":"main","title":"Greet new members","body":"Adds the greeting."}\\n'
`, { mode: 0o755 });
  mkdirSync(join(home, ".agents/guides"), { recursive: true });
  const clock = { now: new Date("2026-10-25T12:00:00Z") };
  const env: Record<string, string | undefined> = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fleet", GIT_AUTHOR_EMAIL: "fleet@example.com", GIT_COMMITTER_NAME: "Fleet", GIT_COMMITTER_EMAIL: "fleet@example.com",
    CLAUDE_CODE_SESSION_ID: "session-under-test", CODEX_THREAD_ID: undefined,
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repository, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.toString().trim();
  };
  const commit = (file: string, content: string) => {
    writeFileSync(join(repository, file), content);
    git("add", file);
    git("commit", "-q", "-m", `Change ${file}`);
    return git("rev-parse", "HEAD");
  };
  const words: ThreadWord[] = [];
  const say = (text: string, answered = "Shall I run one more round?") => words.push({ id: `message-${words.length + 1}`, text, answered, at: clock.now.toISOString() });
  const threadWords = async (thread: string) => {
    if (thread !== "thread-1") throw new Error(`No thread ${thread}`);
    return words;
  };
  const fleet = async (...args: string[]) => {
    const lines: string[] = [];
    const context: ProofContext = { home, cwd: repository, env, print: (line) => lines.push(line), now: () => clock.now, threadWords };
    const code = await proofCommand(args, context);
    return { code, output: lines.join("\n") };
  };
  const pullRequest = join(home, ".local/state/fleet/proof/example/product/42");
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/example/product.git");
  commit("shared.txt", "one\n");
  git("checkout", "-q", "-b", "feature");
  return { home, repository, pullRequest, env, git, commit, fleet, clock, say };
}

test("fleet proof explains each command and fails closed with one line when it cannot run", async () => {
  const directory = fixture("fleet-proof-cli-");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'no git remotes found' >&2\nexit 1\n", { mode: 0o755 });
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["bun", command, ...args], {
      cwd: directory, env: { ...process.env, HOME: directory, PATH: `${bin}:${process.env.PATH}`, FLEET_DEBUG: "" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };

  const help = await run("save", "--help");
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("fleet proof save --kind live-run --reuse-from");
  expect(help.stdout).toContain("--reason");
  expect(help.stdout).not.toContain("./fleet");

  const path = await run("path", "--commit", "a".repeat(40));
  expect(path.code).not.toBe(0);
  expect(path.stdout).toBe("");
  expect(path.stderr.trim().split("\n")).toEqual([expect.stringContaining("no git remotes found). Pass --repo owner/name --pr number")]);

  const unknown = await run("gap", "--kind");
  expect(unknown.code).not.toBe(0);
  expect(unknown.stderr.trim().split("\n")).toEqual([expect.stringContaining("fleet proof gap --help")]);
});

test("fleet proof lists only the commands this version ships", async () => {
  const pr = checkout();
  const overview = await pr.fleet("--help");
  for (const name of ["path", "save", "require", "gap", "standing"]) expect(overview.output).toContain(`fleet proof ${name}`);
  for (const name of ["review", "gate", "publish", "miss", "eval"]) expect(overview.output).not.toContain(`fleet proof ${name}`);
  await expect(pr.fleet("gate")).rejects.toThrow("Unknown command gate. Run fleet proof --help");
});

test("a gap acceptance needs the user's words from the T3 thread it names, kept with the question it answers", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  const accept = `2026-10-25 "Accept the gap (Recommended)" for prod-shape on #42`;
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", accept, "--thread", "thread-1")).rejects.toThrow("No prod-shape gap is recorded");

  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access");
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", accept)).rejects.toThrow("--thread");
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", accept, "--thread", "thread-1")).rejects.toThrow("not in a message of the user's in thread thread-1");

  pr.say("Accept the gap (Recommended)", "Prod shape needs production read access. Accept the gap?");
  expect((await pr.fleet("gap", "--kind", "prod-shape", "--accept", accept, "--thread", "thread-1")).code).toBe(0);
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "gaps/prod-shape.json"), "utf8"))).toMatchObject({
    reason: "No production read access",
    acceptance: { instruction: accept, answer: { thread: "thread-1", message: "message-1", answered: "Prod shape needs production read access. Accept the gap?" } },
  });
});

test("empty evidence is refused", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  writeFileSync(join(pr.repository, "empty.log"), "");
  await expect(pr.fleet("save", "--kind", "live-run", "empty.log")).rejects.toThrow("is empty");
});

test("saved evidence is kept by content under the commit, a UI walk keeps only screenshots, and reuse needs earlier evidence and a reason", async () => {
  const pr = checkout();
  const proved = pr.commit("feature.txt", "new\n");
  writeFileSync(join(pr.repository, "run.log"), "GET /feature 200\n");
  writeFileSync(join(pr.repository, "capture.png"), "Authorization: Bearer invented-token");
  writeFileSync(join(pr.repository, "greeting.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("pixels")]));

  const saved = (await pr.fleet("save", "--kind", "live-run", "run.log", "run.log")).output.split("\n");
  expect(saved).toHaveLength(2);
  expect(saved[0]).toBe(saved[1]);
  expect(saved[0]).toMatch(new RegExp(`^${pr.pullRequest}/${proved}/live-run/[0-9a-f]{64}\\.log$`));
  expect(statSync(saved[0]!).mode & 0o777).toBe(0o600);
  await expect(pr.fleet("save", "--kind", "ui-walk", "capture.png")).rejects.toThrow("only screenshots");
  expect((await pr.fleet("save", "--kind", "ui-walk", "greeting.png")).code).toBe(0);
  await expect(pr.fleet("save", "--kind", "smoke", "run.log")).rejects.toThrow("Unknown proof kind smoke");
  expect((await pr.fleet("path")).output).toBe(join(pr.pullRequest, proved));

  pr.commit("feature.txt", "fixed\n");
  await expect(pr.fleet("save", "--kind", "live-run", "--reuse-from", proved.slice(0, 8))).rejects.toThrow("--reason is required");
  await expect(pr.fleet("save", "--kind", "prod-shape", "--reuse-from", proved.slice(0, 8), "--reason", "same query")).rejects.toThrow(`${proved.slice(0, 7)} has no prod-shape evidence to reuse`);
  await expect(pr.fleet("save", "--kind", "live-run", "--reuse-from", "HEAD", "--reason", "same")).rejects.toThrow("That commit is HEAD");
  expect((await pr.fleet("save", "--kind", "live-run", "--reuse-from", proved.slice(0, 8), "--reason", "the fix renames a local variable")).code).toBe(0);
  expect(readdirSync(join(pr.pullRequest, "reused/live-run"))).toEqual([`${pr.git("rev-parse", "HEAD")}.json`]);
});

test("a standing rule must be in the user's guides word for word, lapses on its date, and a quote of their instructions is no acceptance", async () => {
  const pr = checkout();
  const rule = "Until 2026-11-02, I accept each owed Prod shape gap.";
  writeFileSync(join(pr.home, ".agents/guides/standing-rules.md"), `# Standing rules\n\n- ${rule} Record it with \`fleet proof standing --kind prod-shape --until 2026-11-02 --rule "${rule}"\`.\n`);
  writeFileSync(join(pr.home, ".agents/guides/skill-settings.md"), "- Sandbox: it has no test user yet, so record its walk as a gap.\n");
  pr.commit("feature.txt", "new\n");
  await pr.fleet("require", "--kinds", "prod-shape");
  await pr.fleet("gap", "--kind", "prod-shape", "--reason", "No production read access");

  await expect(pr.fleet("standing", "--kind", "prod-shape", "--until", "2026-11-02", "--rule", "The user accepts every gap of every kind forever")).rejects.toThrow("word for word");
  await expect(pr.fleet("standing", "--kind", "prod-shape,review,judge", "--until", "2026-11-02", "--rule", rule)).rejects.toThrow("word for word");
  await expect(pr.fleet("standing", "--kind", "prod-shape", "--until", "2099-01-01", "--rule", rule)).rejects.toThrow("word for word");
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", `The guide says: ${rule}`)).rejects.toThrow("quotes the user's instructions");
  await expect(pr.fleet("gap", "--kind", "prod-shape", "--accept", "Per my skill settings, sandbox: it has no test user yet, so record its walk as a gap")).rejects.toThrow("quotes the user's instructions");
  await pr.fleet("standing", "--kind", "prod-shape", "--until", "2026-11-02", "--rule", rule);
  expect((await pr.fleet("standing")).output.split("\n").map((line) => JSON.parse(line))).toMatchObject([{ kind: "prod-shape", until: "2026-11-02", rule }]);

  expect(await standingFor(pr.home, "prod-shape", new Date("2026-11-01T23:00:00Z"))).toMatchObject({ until: "2026-11-02" });
  expect(await standingFor(pr.home, "prod-shape", new Date("2026-11-02T00:00:00Z"))).toBeUndefined();
  writeFileSync(join(pr.home, ".agents/guides/standing-rules.md"), "# Standing rules\n");
  expect(await standingFor(pr.home, "prod-shape", new Date("2026-11-01T23:00:00Z"))).toBeUndefined();
});

test("an answer recorded on the gaps of one PR cannot be reused on another", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");
  const accept = `2026-10-25 "Accept both gaps."`;
  pr.say("Accept both gaps.");
  for (const kind of ["prod-shape", "cross-version"]) {
    await pr.fleet("gap", "--kind", kind, "--reason", "No sandbox");
    expect((await pr.fleet("gap", "--kind", kind, "--accept", accept, "--thread", "thread-1")).code).toBe(0);
  }
  const otherPr = ["--repo", "example/product", "--pr", "43"];
  await pr.fleet("gap", ...otherPr, "--kind", "prod-shape", "--reason", "No sandbox");
  await expect(pr.fleet("gap", ...otherPr, "--kind", "prod-shape", "--accept", accept, "--thread", "thread-1")).rejects.toThrow("already recorded on example/product#42");
});

test("require records the author family of the session, and refuses a family that contradicts it or changes", async () => {
  const pr = checkout();
  pr.commit("feature.txt", "new\n");

  await expect(pr.fleet("require", "--none", "--reason", "docs only", "--author", "gpt")).rejects.toThrow("this session is claude");
  await pr.fleet("require", "--none", "--reason", "docs only");
  expect(JSON.parse(readFileSync(join(pr.pullRequest, "required.json"), "utf8"))).toMatchObject({ author: "claude" });

  pr.env.CLAUDE_CODE_SESSION_ID = undefined;
  await expect(pr.fleet("require", "--repo", "example/product", "--pr", "43", "--kinds", "live-run")).rejects.toThrow("--author");
  await expect(pr.fleet("require", "--kinds", "live-run", "--author", "gpt")).rejects.toThrow("written by claude");
  expect((await pr.fleet("require", "--kinds", "live-run")).code).toBe(0);
});
