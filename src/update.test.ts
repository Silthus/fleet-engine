import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileFile } from "./pack/types.ts";
import { git, isolateGit, tempDirs } from "./testing/git.ts";
import { noticePath, readNotice, update } from "./update.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

function engineRemote(tags: string[]) {
  const dir = temp.make("engine-remote-");
  git(dir, "init", "-q", "-b", "main");
  for (const tag of tags) {
    writeFileSync(join(dir, "VERSION"), tag);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", tag);
    git(dir, "tag", tag);
  }
  writeFileSync(join(dir, "VERSION"), "main");
  git(dir, "commit", "-q", "-am", "main");
  return dir;
}

function engineCheckout(remote: string, ref: string) {
  const dir = temp.make("engine-");
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "fetch", "-q", "--depth", "1", "origin", ref);
  git(dir, "checkout", "-q", "--detach", "FETCH_HEAD");
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
    const remote = engineRemote(["v0.1.0", "v0.1.1", "v0.2.0", "v1.0.0"]);
    const result = await run(engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 0, applied: 1 });
    expect(result.version).toBe("v0.2.0");
    expect(result.output).toContain("Fleet v1.0.0 is out. It is a new major version, so this update stays on v0.");
    expect(await readNotice(result.home)).toStartWith("Fleet v1.0.0 is out.");
  });

  test("clears the notice when no new major exists", async () => {
    const remote = engineRemote(["v0.1.0", "v0.1.1"]);
    const result = await run(engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result.version).toBe("v0.1.1");
    expect(existsSync(noticePath(result.home))).toBe(false);
  });

  test("moves the track channel to main", async () => {
    const remote = engineRemote(["v0.1.0", "v1.0.0"]);
    const result = await run(engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "main", channel: "track" });
    expect(result.version).toBe("main");
    expect(result.applied).toBe(1);
  });

  test("fast-forwards the profile before it applies", async () => {
    const remote = engineRemote(["v0.1.0"]);
    const profileRemote = temp.make("profile-remote-");
    git(profileRemote, "init", "-q", "-b", "main");
    writeFileSync(join(profileRemote, "fleet.json"), "{}\n");
    git(profileRemote, "add", ".");
    git(profileRemote, "commit", "-q", "-m", "start");
    const profileDir = temp.make("profile-");
    git(profileDir, "clone", "-q", profileRemote, ".");
    writeFileSync(join(profileRemote, "fleet.json"), '{"plan":"claude"}\n');
    git(profileRemote, "commit", "-q", "-am", "answers");
    await run(engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" }, profileDir);
    expect(await Bun.file(join(profileDir, "fleet.json")).text()).toBe('{"plan":"claude"}\n');
  });

  test("does not apply when the engine cannot be fetched", async () => {
    const engineDir = engineCheckout(engineRemote(["v0.1.0"]), "v0.1.0");
    git(engineDir, "remote", "set-url", "origin", join(temp.make(), "gone"));
    const result = await run(engineDir, { repo: "gone", ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 1, applied: 0 });
    expect(result.output).toContain("could not fetch the engine");
  });

  test("refuses an engine checkout with local changes", async () => {
    const engineDir = engineCheckout(engineRemote(["v0.1.0", "v0.1.1"]), "v0.1.0");
    writeFileSync(join(engineDir, "VERSION"), "patched");
    const result = await run(engineDir, { repo: "unused", ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 1, applied: 0, output: expect.stringContaining("has local changes") });
    expect(result.version).toBe("patched");
  });

  test("follows the profile's engine repository", async () => {
    const original = engineRemote(["v0.1.0"]);
    const engineDir = engineCheckout(original, "v0.1.0");
    // A moved engine is a fork or mirror, so its tags point at the same commits.
    const moved = temp.make("engine-moved-");
    git(moved, "clone", "-q", original, ".");
    writeFileSync(join(moved, "VERSION"), "v0.2.0");
    git(moved, "commit", "-q", "-am", "v0.2.0");
    git(moved, "tag", "v0.2.0");
    const result = await run(engineDir, { repo: moved, ref: "v0.1.0", channel: "release" });
    expect(result.output).toContain(`The engine now comes from ${moved}.`);
    expect(result.version).toBe("v0.2.0");
  });

  test("never moves an engine that is not on a release back to one", async () => {
    const remote = engineRemote(["v0.1.0"]);
    const result = await run(engineCheckout(remote, "main"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 0, applied: 1, output: expect.stringContaining("is not a release, so fleet update does not move it back") });
    expect(result.version).toBe("main");
  });

  test("stops before apply when the track checkout fails", async () => {
    const remote = engineRemote(["v0.1.0"]);
    const engineDir = engineCheckout(remote, "v0.1.0");
    writeFileSync(join(engineDir, ".git", "index.lock"), "");
    const result = await run(engineDir, { repo: remote, ref: "main", channel: "track" });
    expect(result).toMatchObject({ code: 1, applied: 0, output: expect.stringContaining("could not check out main") });
    expect(result.version).toBe("v0.1.0");
  });
});
