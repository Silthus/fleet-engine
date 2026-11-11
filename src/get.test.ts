import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./testing/git.ts";
import { getShHarness, repoRoot } from "./testing/get-sh.ts";

const { engine, sandbox, profile, getSh } = getShHarness();

describe("get.sh", () => {
  test("passes sh -n", () => {
    expect(Bun.spawnSync(["sh", "-n", join(repoRoot, "get.sh")]).exitCode).toBe(0);
    expect(Bun.spawnSync(["sh", "-n", join(repoRoot, "templates/profile/install.sh")]).exitCode).toBe(0);
  });

  test("on Linux installs gh and T3 Code, fetches the engine at its pin, and applies the profile", () => {
    const box = sandbox("Linux");
    const result = getSh(box, ["--ref", "v0.1.0", "--profile", profile()]);
    expect(result.output).toContain("Applied 14 changes.");
    expect(result.code).toBe(0);
    expect(existsSync(join(box.home, ".local/bin/gh"))).toBe(true);
    expect(result.calls).toContain("t3 installer channel=nightly");
    expect(result.calls).not.toContain("brew");
    expect(git(join(box.home, ".local/share/fleet/engine"), "describe", "--tags")).toBe("v0.1.0");
    expect(readFileSync(join(box.home, ".agents/AGENTS.md"), "utf8")).toStartWith("# Agent rules\n");
  });

  test("--install-only installs the tools and the engine, then stops before setup", () => {
    const box = sandbox("Linux");
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(result.output).toEndWith("Fleet: Engine ready at v0.1.0 in " + join(box.home, ".local/share/fleet/engine") + ".\n");
    expect(existsSync(join(box.home, ".local/bin/gh"))).toBe(true);
    expect(existsSync(join(box.home, ".config/fleet/machine.json"))).toBe(false);
  });

  test("logs when the install started and when each phase ended, for fleet setup's timings", () => {
    const box = sandbox("Linux");
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    const lines = readFileSync(join(box.home, ".local/state/fleet/logs/install-timings"), "utf8").trim().split("\n").map((line) => line.split(" "));
    expect(lines.map((words) => words[0])).toEqual(["start", "tools", "t3", "engine", "packages"]);
    const times = lines.map((words) => Number(words[1]));
    expect(times.every((time, index) => time >= (times[index - 1] ?? 0) && Math.abs(time * 1000 - Date.now()) < 600_000)).toBe(true);
    expect(lines.every((words) => words.length === 2)).toBe(true);
  });

  test("installs the engine's packages in the engine directory", () => {
    const box = sandbox("Linux");
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    const engineDir = join(box.home, ".local/share/fleet/engine");
    const calls = result.calls.split("\n");
    expect(calls).toContain("bun install --frozen-lockfile --production");
    expect(calls).toContain(`bun install ran in ${engineDir}`);
    expect(git(engineDir, "status", "--porcelain")).toBe("");
  });

  test("stops with the installer's output when the engine's packages do not install", () => {
    const box = sandbox("Linux");
    box.stub("bun", `[ "$1" = install ] || exec "${process.execPath}" "$@"\necho "lockfile is out of date" >&2\nexit 1`);
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("lockfile is out of date");
    expect(result.output).toContain("Fleet: could not install the engine's packages in " + join(box.home, ".local/share/fleet/engine") + ".");
  });

  test("a second run changes nothing", () => {
    const box = sandbox("Linux");
    const dir = profile();
    expect(getSh(box, ["--ref", "v0.1.0", "--profile", dir]).code).toBe(0);
    const again = getSh(box, ["--ref", "v0.1.0", "--profile", dir]);
    expect(again.code).toBe(0);
    expect(again.output).toContain("Applied 0 changes.");
  });

  test("passes flags after -- to fleet and rejects others", () => {
    const box = sandbox("Linux");
    expect(getSh(box, ["--preset", "everyday"])).toMatchObject({ code: 1, output: expect.stringContaining("unknown option --preset. Put flags for fleet after --.") });
    const result = getSh(box, ["--ref", "v0.1.0", "--", "--preset", "nope"]);
    expect(result).toMatchObject({ code: 2, output: expect.stringContaining("fleet setup: --preset nope: choose starter, everyday, everything") });
  });
});
