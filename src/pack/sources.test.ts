import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, isolateGit, tempDirs } from "../testing/git.ts";
import { fetchSource } from "./sources.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

function packRepo(summary: string) {
  const dir = temp.make("pack-repo-");
  git(dir, "init", "-q", "-b", "main");
  writePack(dir, summary);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "v1");
  git(dir, "tag", "v1");
  return dir;
}

function writePack(dir: string, summary: string) {
  mkdirSync(join(dir, "packs", "team"), { recursive: true });
  writeFileSync(join(dir, "packs", "team", "pack.json"), JSON.stringify({ schema: 1, name: "team", summary }));
}

describe("fetchSource", () => {
  test("checks a source out at its pinned ref", async () => {
    const repo = packRepo("Team rules v1.");
    writePack(repo, "Team rules v2.");
    git(repo, "commit", "-q", "-am", "v2");
    const fetched = await fetchSource({ name: "team", repo, ref: "v1" }, temp.make("cache-"));
    if ("error" in fetched) throw new Error(fetched.error);
    expect(fetched.packs[0]?.manifest.summary).toBe("Team rules v1.");
    expect(fetched.stale).toBeUndefined();
  });

  test("keeps the last fetched packs when the source is unreachable", async () => {
    const repo = packRepo("Team rules v1.");
    const cache = temp.make("cache-");
    await fetchSource({ name: "team", repo, ref: "v1" }, cache);
    rmSync(repo, { recursive: true, force: true });
    const fetched = await fetchSource({ name: "team", repo, ref: "v2" }, cache);
    if ("error" in fetched) throw new Error(fetched.error);
    expect(fetched.packs[0]?.manifest.summary).toBe("Team rules v1.");
    expect(fetched.stale).toContain("could not fetch v2");
  });

  test("reports an error for an unreachable source never fetched before", async () => {
    const fetched = await fetchSource({ name: "team", repo: join(temp.make(), "missing"), ref: "v1" }, temp.make("cache-"));
    expect(fetched).toMatchObject({ error: expect.stringContaining("could not fetch v1") });
  });
});
