import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGit } from "../../../src/testing/git.ts";
import { mapTracker } from "./tracker.ts";

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function profileWithOrigin(origin?: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), "fleet-tracker-"));
  cleanups.push(profile);
  await spawnGit(profile, "init", "-q");
  if (origin) await spawnGit(profile, "remote", "add", "origin", origin);
  return profile;
}

test("the tracker setting wins over the profile repo", async () => {
  expect(mapTracker("acme/maps", await profileWithOrigin("https://github.com/globex/fleet-profile.git"))).toBe("acme/maps");
});

test("an unset tracker falls back to the profile repo's GitHub origin", async () => {
  for (const origin of ["https://github.com/globex/fleet-profile.git", "https://github.com/globex/fleet-profile", "git@github.com:globex/fleet-profile.git", "ssh://git@github.com/globex/fleet-profile.git"]) {
    expect(mapTracker(undefined, await profileWithOrigin(origin))).toBe("globex/fleet-profile");
    expect(mapTracker("", await profileWithOrigin(origin))).toBe("globex/fleet-profile");
  }
});

test("no tracker comes from a profile without a GitHub origin", async () => {
  expect(mapTracker(undefined, await profileWithOrigin("https://git.example.test/acme/fleet-profile.git"))).toBe("");
  expect(mapTracker(undefined, await profileWithOrigin())).toBe("");
  expect(mapTracker(undefined, join(tmpdir(), "fleet-no-such-profile"))).toBe("");
  expect(mapTracker(undefined, undefined)).toBe("");
});

test("only a github.com origin, in its SSH or HTTPS form, names the tracker", async () => {
  const accepted = [
    "https://github.com/acme/maps/", "git@github.com:acme/maps", "ssh://git@github.com/acme/maps", "ssh://git@github.com/acme/maps.git", "ssh://git@github.com:22/acme/maps.git",
  ];
  const rejected = [
    "https://notgithub.com/acme/maps.git", "https://github.com.evil.test/acme/maps.git", "https://evil.test/github.com/acme/maps.git",
    "git@notgithub.com:acme/maps.git", "git@evil.test:github.com/acme/maps.git", "ssh://git@notgithub.com/acme/maps",
    "http://github.com/acme/maps.git", "https://github.com/acme/maps/tree/main", "https://github.com/acme", "git://github.com/acme/maps.git",
    "ssh://git@github.com:2222/acme/maps.git", "https://github.com:8443/acme/maps.git",
  ];
  for (const origin of accepted) expect(mapTracker(undefined, await profileWithOrigin(origin))).toBe("acme/maps");
  for (const origin of rejected) expect([origin, mapTracker(undefined, await profileWithOrigin(origin))]).toEqual([origin, ""]);
});
