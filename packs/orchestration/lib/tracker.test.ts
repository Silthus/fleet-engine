import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../../src/testing/git.ts";
import { mapTracker } from "./tracker.ts";

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function profileWithOrigin(origin?: string): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), "fleet-tracker-"));
  cleanups.push(profile);
  git(profile, "init", "-q");
  if (origin) git(profile, "remote", "add", "origin", origin);
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
