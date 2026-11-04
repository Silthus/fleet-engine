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
  return { code, home, applied, output: lines.join("\n"), version: Bun.file(join(engineDir, "VERSION")).text() };
}

describe("fleet update", () => {
  test("moves the release channel to the newest tag of its major and reports a new major", async () => {
    const remote = engineRemote(["v0.1.0", "v0.1.1", "v0.2.0", "v1.0.0"]);
    const result = await run(engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(result).toMatchObject({ code: 0, applied: 1 });
    expect(await result.version).toBe("v0.2.0");
    expect(result.output).toContain("Fleet v1.0.0 is out. It is a new major version, so this update stays on v0.");
    expect(await readNotice(result.home)).toStartWith("Fleet v1.0.0 is out.");
  });

  test("clears the notice when no new major exists", async () => {
    const remote = engineRemote(["v0.1.0", "v0.1.1"]);
    const result = await run(engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "v0.1.0", channel: "release" });
    expect(await result.version).toBe("v0.1.1");
    expect(existsSync(noticePath(result.home))).toBe(false);
  });

  test("moves the track channel to main", async () => {
    const remote = engineRemote(["v0.1.0", "v1.0.0"]);
    const result = await run(engineCheckout(remote, "v0.1.0"), { repo: remote, ref: "main", channel: "track" });
    expect(await result.version).toBe("main");
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
});
