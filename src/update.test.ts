import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileFile } from "./pack/types.ts";
import { isolateGit, spawnGit, tempDirs } from "./testing/git.ts";
import { spawnAsync } from "./testing/spawn.ts";
import { noticePath, readNotice, update } from "./update.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

async function engineRemote(tags: string[]) {
  const dir = temp.make("engine-remote-");
  await spawnGit(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "engine" }));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  for (const tag of tags) {
    writeFileSync(join(dir, "VERSION"), tag);
    await spawnGit(dir, "add", ".");
    await spawnGit(dir, "commit", "-q", "-m", tag);
    await spawnGit(dir, "tag", tag);
  }
  writeFileSync(join(dir, "VERSION"), "main");
  await spawnGit(dir, "commit", "-q", "-am", "main");
  return dir;
}

async function engineCheckout(remote: string, ref: string) {
  const dir = temp.make("engine-");
  await spawnGit(dir, "init", "-q");
  await spawnGit(dir, "remote", "add", "origin", remote);
  await spawnGit(dir, "fetch", "-q", "--depth", "1", "origin", ref);
  await spawnGit(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
  return dir;
}

async function run(engineDir: string, engine: ProfileFile["engine"], profileDir = temp.make("profile-")) {
  const home = temp.make("home-");
  const lines: string[] = [];
  let applied = 0;
  const code = await update({ home, engineDir, profileDir, engine, print: (line) => lines.push(line), runApply: async () => (applied++, 0) });
  return { code, home, applied, output: lines.join("\n"), version: await Bun.file(join(engineDir, "VERSION")).text() };
}

describe("fleet update", () => {
  test("moves the release channel to the newest tag of its major and reports a new major", async () => {
    const remote = await engineRemote(["v0.1.0", "v0.1.1", "v0.2.0", "v1.0.0"]);
    const result = await run(await engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 0, applied: 1 });
    expect(result.version).toBe("v0.2.0");
    expect(result.output).toContain("Fleet v1.0.0 is out. It is a new major version, so this update stays on v0.");
    expect(await readNotice(result.home)).toStartWith("Fleet v1.0.0 is out.");
  });

  test("clears the notice when no new major exists", async () => {
    const remote = await engineRemote(["v0.1.0", "v0.1.1"]);
    const result = await run(await engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result.version).toBe("v0.1.1");
    expect(existsSync(noticePath(result.home))).toBe(false);
  });

  test("moves the track channel to main", async () => {
    const remote = await engineRemote(["v0.1.0", "v1.0.0"]);
    const result = await run(await engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "main", channel: "track" });
    expect(result.version).toBe("main");
    expect(result.applied).toBe(1);
  });

  test("fast-forwards the profile before it applies", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const profileRemote = temp.make("profile-remote-");
    await spawnGit(profileRemote, "init", "-q", "-b", "main");
    writeFileSync(join(profileRemote, "fleet.json"), "{}\n");
    await spawnGit(profileRemote, "add", ".");
    await spawnGit(profileRemote, "commit", "-q", "-m", "start");
    const profileDir = temp.make("profile-");
    await spawnGit(profileDir, "clone", "-q", profileRemote, ".");
    writeFileSync(join(profileRemote, "fleet.json"), '{"plan":"claude"}\n');
    await spawnGit(profileRemote, "commit", "-q", "-am", "answers");
    await run(await engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" }, profileDir);
    expect(await Bun.file(join(profileDir, "fleet.json")).text()).toBe('{"plan":"claude"}\n');
  });

  test("does not apply when the engine cannot be fetched", async () => {
    const engineDir = await engineCheckout(await engineRemote(["v0.1.0"]), "v0.1.0");
    await spawnGit(engineDir, "remote", "set-url", "origin", join(temp.make(), "gone"));
    const result = await run(engineDir, { repo: "gone", ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 1, applied: 0 });
    expect(result.output).toContain("could not fetch the engine");
  });

  test("refuses an engine checkout with local changes", async () => {
    const engineDir = await engineCheckout(await engineRemote(["v0.1.0", "v0.1.1"]), "v0.1.0");
    writeFileSync(join(engineDir, "VERSION"), "patched");
    const result = await run(engineDir, { repo: "unused", ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 1, applied: 0, output: expect.stringContaining("has local changes") });
    expect(result.version).toBe("patched");
  });

  test("follows the profile's engine repository", async () => {
    const original = await engineRemote(["v0.1.0"]);
    const engineDir = await engineCheckout(original, "v0.1.0");
    // A moved engine is a fork or mirror, so its tags point at the same commits.
    const moved = temp.make("engine-moved-");
    await spawnGit(moved, "clone", "-q", original, ".");
    writeFileSync(join(moved, "VERSION"), "v0.2.0");
    await spawnGit(moved, "commit", "-q", "-am", "v0.2.0");
    await spawnGit(moved, "tag", "v0.2.0");
    const result = await run(engineDir, { repo: moved, ref: "v0.1.0", channel: "release" });
    expect(result.output).toContain(`The engine now comes from ${moved}.`);
    expect(result.version).toBe("v0.2.0");
  });

  test("never moves an engine that is not on a release back to one", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const result = await run(await engineCheckout(remote, "main"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 0, applied: 1, output: expect.stringContaining("is not a release, so fleet update does not move it back") });
    expect(result.version).toBe("main");
  });

  test("installs the packages the new engine needs before it applies", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    mkdirSync(join(remote, "dep"));
    writeFileSync(join(remote, "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
    writeFileSync(join(remote, "package.json"), JSON.stringify({ name: "engine", dependencies: { dep: "file:./dep" } }));
    expect((await spawnAsync([process.execPath, "install"], { cwd: remote })).exitCode).toBe(0);
    writeFileSync(join(remote, "VERSION"), "v0.2.0");
    await spawnGit(remote, "add", ".");
    await spawnGit(remote, "commit", "-q", "-m", "v0.2.0");
    await spawnGit(remote, "tag", "v0.2.0");
    const result = await run(engineDir, { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 0, applied: 1, version: "v0.2.0" });
    expect(existsSync(join(engineDir, "node_modules", "dep", "package.json"))).toBe(true);
    expect(await spawnGit(engineDir, "status", "--porcelain")).toBe("");
  });

  test("stops before apply when the engine's packages do not install", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    writeFileSync(join(remote, "package.json"), JSON.stringify({ name: "engine", dependencies: { missing: "file:./missing" } }));
    writeFileSync(join(remote, "VERSION"), "v0.2.0");
    await spawnGit(remote, "commit", "-q", "-am", "v0.2.0");
    await spawnGit(remote, "tag", "v0.2.0");
    const before = await spawnGit(engineDir, "rev-parse", "HEAD");
    const result = await run(engineDir, { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 1, applied: 0, version: "v0.1.0" });
    expect(await spawnGit(engineDir, "rev-parse", "HEAD")).toBe(before);
    expect(result.output).toContain(`could not install the engine's packages in ${engineDir}, so the update was rolled back. The engine stays at ${before.slice(0, 7)}.\n`);
  });

  test("puts back the old engine's packages when the new engine's install fails halfway", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const release = async (version: string, dep: string, scripts?: Record<string, string>) => {
      mkdirSync(join(remote, "dep"), { recursive: true });
      writeFileSync(join(remote, "dep", "package.json"), JSON.stringify({ name: "dep", version: dep }));
      writeFileSync(join(remote, "package.json"), JSON.stringify({ name: "engine", dependencies: { dep: "file:./dep" }, ...(scripts ? { scripts } : {}) }));
      expect((await spawnAsync([process.execPath, "install", "--ignore-scripts"], { cwd: remote })).exitCode).toBe(0);
      writeFileSync(join(remote, "VERSION"), version);
      await spawnGit(remote, "add", ".");
      await spawnGit(remote, "commit", "-q", "-m", version);
      await spawnGit(remote, "tag", version);
    };
    await release("v0.1.1", "1.0.0");
    await release("v0.2.0", "2.0.0", { postinstall: "exit 1" });
    const engineDir = await engineCheckout(remote, "v0.1.1");
    expect((await spawnAsync([process.execPath, "install", "--frozen-lockfile", "--production"], { cwd: engineDir })).exitCode).toBe(0);
    const installed = () => JSON.parse(readFileSync(join(engineDir, "node_modules", "dep", "package.json"), "utf8")).version;
    expect(installed()).toBe("1.0.0");
    const result = await run(engineDir, { repo: remote, ref: "v0.1.1", channel: "release" });
    expect(result).toMatchObject({ code: 1, applied: 0, version: "v0.1.1" });
    expect(installed()).toBe("1.0.0");
  });

  test("stops before apply when the track checkout fails", async () => {
    const remote = await engineRemote(["v0.1.0"]);
    const engineDir = await engineCheckout(remote, "v0.1.0");
    writeFileSync(join(engineDir, ".git", "index.lock"), "");
    const result = await run(engineDir, { repo: remote, ref: "main", channel: "track" });
    expect(result).toMatchObject({ code: 1, applied: 0, output: expect.stringContaining("could not check out main") });
    expect(result.version).toBe("v0.1.0");
  });
});
