import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./testing/git.ts";
import { getShHarness, repoRoot } from "./testing/get-sh.ts";

const { temp, engine, sandbox, profile, getSh } = getShHarness();

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
    expect(result).toMatchObject({ code: 2, output: expect.stringContaining("fleet setup: --preset nope: choose starter, everyday, michael") });
  });
});

describe("get.sh downloads", () => {
  const curlCalls = (calls: string) => calls.split("\n").filter((call) => call.startsWith("curl "));

  test("tries a failed download again, and goes on when a later try works", () => {
    const box = sandbox("Linux");
    box.failDownloads("*gh_9.9.9_linux_amd64.tar.gz", 2);
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(existsSync(join(box.home, ".local/bin/gh"))).toBe(true);
    expect(curlCalls(result.calls).filter((call) => call.includes("gh_9.9.9_linux_amd64.tar.gz"))).toHaveLength(3);
    expect(result.calls.split("\n")).toEqual(expect.arrayContaining(["sleep 1", "sleep 2"]));
  });

  test("stops after three failed tries and names what it could not download", () => {
    const box = sandbox("Linux");
    box.failDownloads("*gh_9.9.9_linux_amd64.tar.gz", 99);
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Fleet: could not download gh.");
    expect(curlCalls(result.calls).filter((call) => call.includes("gh_9.9.9_linux_amd64.tar.gz"))).toHaveLength(3);
  });

  test("gives up on a download that cannot connect or stalls, the T3 Code installer's too, and tries it again", () => {
    const box = sandbox("Linux");
    box.stallDownloads("*gh_9.9.9_linux_amd64.tar.gz", 1);
    box.stallDownloads("*/SHA256SUMS", 1);
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(result.calls).not.toContain("curl hangs on");
    expect(curlCalls(result.calls).filter((call) => call.includes("gh_9.9.9_linux_amd64.tar.gz"))).toHaveLength(2);
    expect(curlCalls(result.calls).filter((call) => call.includes("/SHA256SUMS"))).toHaveLength(2);
    expect(existsSync(join(box.home, ".local/bin/t3"))).toBe(true);
  });

  test("installs the newest T3 Code nightly from the releases feed, so the installer never asks the GitHub API", () => {
    const box = sandbox("Linux");
    const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
    expect(result.code).toBe(0);
    expect(result.calls).toContain("t3 installer channel=nightly version=0.1.9-nightly.20990102.7\n");
  });

  test("lets the T3 Code installer find the nightly itself when the releases feed is down or names none", () => {
    const down = sandbox("Linux");
    down.failDownloads("*releases.atom", 99);
    const empty = sandbox("Linux", { releasesFeed: "<feed></feed>" });
    for (const box of [down, empty]) {
      const result = getSh(box, ["--ref", "v0.1.0", "--install-only"]);
      expect(result.code).toBe(0);
      expect(result.calls).toContain("t3 installer channel=nightly version=\n");
    }
  });

  test("runs the T3 Code installer again when it fails, up to three times", () => {
    const recovers = sandbox("Linux", { t3Failures: 2 });
    const recovered = getSh(recovers, ["--ref", "v0.1.0", "--install-only"]);
    expect(recovered.code).toBe(0);
    expect(recovered.calls.split("\n").filter((call) => call.startsWith("t3 installer"))).toHaveLength(3);
    expect(existsSync(join(recovers.home, ".local/bin/t3"))).toBe(true);

    const broken = sandbox("Linux", { t3Failures: 99 });
    const tmp = join(broken.root, "tmp");
    mkdirSync(tmp);
    const failed = getSh(broken, ["--ref", "v0.1.0", "--install-only"], { env: { TMPDIR: tmp } });
    expect(failed.code).toBe(1);
    expect(readdirSync(tmp).filter((name) => existsSync(join(tmp, name, "curl")))).toEqual([]);
    expect(failed.output).toContain("returned HTTP 403");
    expect(failed.output).toContain("Fleet: T3 Code did not install.");
    expect(failed.calls.split("\n").filter((call) => call.startsWith("t3 installer"))).toHaveLength(3);
  });
});

describe("get.sh with an existing engine directory", () => {
  test("refuses a directory that is not an engine, and an engine with local changes", () => {
    const box = sandbox("Linux");
    const engineDir = join(box.home, ".local/share/fleet/engine");
    mkdirSync(engineDir, { recursive: true });
    writeFileSync(join(engineDir, "notes.txt"), "mine\n");
    expect(getSh(box, ["--ref", "v0.1.0", "--profile", profile()])).toMatchObject({ code: 1, output: expect.stringContaining("holds files that are not a Fleet engine") });
    expect(readFileSync(join(engineDir, "notes.txt"), "utf8")).toBe("mine\n");

    const fresh = sandbox("Linux");
    expect(getSh(fresh, ["--ref", "v0.1.0", "--install-only"]).code).toBe(0);
    const installed = join(fresh.home, ".local/share/fleet/engine");
    writeFileSync(join(installed, "fleet"), "# my patch\n");
    expect(getSh(fresh, ["--ref", "v0.1.0", "--profile", profile()])).toMatchObject({ code: 1, output: expect.stringContaining("has local changes") });
    expect(readFileSync(join(installed, "fleet"), "utf8")).toBe("# my patch\n");
  });
});

describe("profile install.sh shim", () => {
  function shim(fleetJson: string, curl: string) {
    const box = sandbox("Linux");
    const dir = temp.make("profile-");
    writeFileSync(join(dir, "fleet.json"), fleetJson);
    cpSync(join(repoRoot, "templates/profile/install.sh"), join(dir, "install.sh"));
    writeFileSync(join(box.bin, "curl"), `#!/bin/sh\necho "curl $*" >> "${box.log}"\n${curl}\n`);
    const result = Bun.spawnSync(["sh", join(dir, "install.sh")], { cwd: box.home, env: { PATH: box.bin, HOME: box.home } });
    return { dir, code: result.exitCode, output: result.stderr.toString(), calls: existsSync(box.log) ? readFileSync(box.log, "utf8") : "" };
  }
  test("runs get.sh from the engine pin of compact JSON with the profile directory", () => {
    const json = '{"engine":{"repo":"Silthus/fleet-engine","ref":"v0.1.0","channel":"release"},"sources":[{"name":"team","repo":"me/team","ref":"v9.0.0"}]}';
    const box = sandbox("Linux");
    const dir = temp.make("profile-");
    writeFileSync(join(dir, "fleet.json"), json);
    cpSync(join(repoRoot, "templates/profile/install.sh"), join(dir, "install.sh"));
    writeFileSync(join(box.bin, "curl"), `#!/bin/sh\necho "curl $*" >> "${box.log}"\nwhile [ $# -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done\necho 'echo "get.sh $*" >> "${box.log}"' > "$out"\n`);
    const result = Bun.spawnSync(["sh", join(dir, "install.sh")], { cwd: box.home, env: { PATH: box.bin, HOME: box.home } });
    expect(result.exitCode).toBe(0);
    const calls = readFileSync(box.log, "utf8");
    expect(calls).toContain("curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/v0.1.0/get.sh -o ");
    expect(calls).toContain(`get.sh --ref v0.1.0 --profile ${dir}`);
  });

  test("fails when the download fails or the pin is missing", () => {
    const failed = shim('{"engine":{"ref":"v0.1.0"}}', "exit 22");
    expect(failed).toMatchObject({ code: 1, output: expect.stringContaining("could not download") });
    expect(shim('{"engine":{"repo":"x"}}', "exit 0")).toMatchObject({ code: 1, output: expect.stringContaining("needs an engine ref") });
  });
});
