import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { pruneOptions } from "../../base/lib/prune.ts";
import type { Result } from "./coder.ts";
import { diskSweep, diskSweepCommand, sweepCleaners, type DiskSweepOptions } from "./disk-sweep.ts";

const gigabyte = 1024 ** 3;
const temp = tempDirs();
afterEach(() => temp.cleanup());

const home = "/home/me";
const launcher = "/home/me/.local/share/fleet/engine/fleet";
const bootLog = "/home/me/.t3/userdata/logs/boot-service.log";
const done: Result = { code: 0, stdout: "", stderr: "" };

function sweep(fields: Partial<DiskSweepOptions> = {}, freed: Record<string, number> = {}) {
  const logged: string[] = [];
  const printed: string[] = [];
  const ran: string[] = [];
  let free = 4 * gigabyte;
  const options: DiskSweepOptions = {
    home, dryRun: false, floorGigabytes: 15, alertGigabytes: 10, free: () => free,
    cleaners: sweepCleaners(home, {}),
    installed: () => true,
    run: async (argv) => {
      ran.push(argv.join(" "));
      free += (freed[argv[0] === "sh" ? "fleet" : argv[0]!] ?? 0) * gigabyte;
      return argv[0] === "du" ? { code: 0, stdout: duOutput, stderr: "" } : done;
    },
    trimLog: (path, limitBytes, keepBytes) => {
      ran.push(`trim ${path} ${limitBytes / 1024 ** 2}M ${keepBytes / 1024 ** 2}M`);
      free += (freed.trim ?? 0) * gigabyte;
    },
    log: (line) => logged.push(line), print: (line) => printed.push(line),
    ...fields,
  };
  return { options, logged, printed, ran };
}

const sizes: Array<[number, string]> = [
  [90, ""], [30, ".cache"], [20, ".cache/uv"], [12, "dev"], [11, "dev/big"], [9, ".t3"], [8, ".t3/worktrees"], [5, "notes"],
  [4, ".bun"], [3, ".bun/install"], [2, "go"], [1, "go/pkg"], [0.5, ".local"],
];
const duOutput = sizes.map(([gigabytes, path]) => `${gigabytes * 1024 * 1024}\t${path ? `${home}/${path}` : home}`).join("\n");

test("the cleaners are the base pack's plain fleet prune, the T3 boot log trim, then the pnpm, uv and Go cache cleaners, in this order, and never fleet prune --auto, T3's storage cleanup, Bun's cache, or docker", async () => {
  expect(sweepCleaners(home, {}).map((cleaner) => ("argv" in cleaner ? cleaner.argv : ["trim", cleaner.trim.path]))).toEqual([
    ["sh", launcher, "prune"],
    ["trim", bootLog],
    ["pnpm", "store", "prune"],
    ["uv", "cache", "prune"],
    ["go", "clean", "-cache"],
  ]);
  expect((sweepCleaners(home, { FLEET_ENGINE_DIR: "/opt/engine" })[0] as { argv: string[] }).argv).toEqual(["sh", "/opt/engine/fleet", "prune"]);
  const run = sweep();
  expect(await diskSweep(run.options)).toBe(0);
  expect(run.ran).toEqual([`sh ${launcher} prune`, `trim ${bootLog} 100M 20M`, "pnpm store prune", "uv cache prune", "go clean -cache", `du -x -k -d 2 ${home}`]);
  expect(run.ran.some((line) => /--auto|docker|bun|runStorageCleanup|nix|cargo/.test(line))).toBe(false);
});

test("the base pack runs the sweep's prune arguments as a plain prune, without the --auto pass that collects Nix garbage and removes Cargo, uv and old T3 files", () => {
  const prune = sweepCleaners(home, {})[0] as { argv: string[] };
  const parsed = pruneOptions(prune.argv.slice(3), () => {}, { home, env: {}, floorGigabytes: 10 });
  expect(parsed.auto).toBeNull();
  expect(parsed.options.dryRun).toBe(false);
});

test("a cleaner whose tool is not installed is skipped", async () => {
  const run = sweep({ installed: (tool) => tool !== "pnpm" && tool !== "go" });
  await diskSweep(run.options);
  expect(run.ran.slice(0, -1)).toEqual([`sh ${launcher} prune`, `trim ${bootLog} 100M 20M`, "uv cache prune"]);
  expect(run.logged).toContain("Skipped pnpm store prune: pnpm is not installed.");
  expect(run.logged).toContain("Skipped go clean -cache: go is not installed.");
});

test("a failing or hanging cleaner is logged, and the next one runs", async () => {
  const run = sweep({
    run: async (argv) => {
      run.ran.push(argv.join(" "));
      if (argv[0] === "uv") return { code: 1, stdout: "", stderr: "uv: something broke\nerror: cache is locked" };
      if (argv[0] === "pnpm") return { code: 124, stdout: "", stderr: "" };
      return argv[0] === "du" ? { code: 0, stdout: duOutput, stderr: "" } : done;
    },
  });
  expect(await diskSweep(run.options)).toBe(0);
  expect(run.ran.slice(0, -1)).toEqual([`sh ${launcher} prune`, `trim ${bootLog} 100M 20M`, "pnpm store prune", "uv cache prune", "go clean -cache"]);
  expect(run.logged).toEqual([
    "Sweep: 4.0G free, floor 15G.",
    "fleet prune: done. 4.0G free.",
    "trim the T3 boot log: done. 4.0G free.",
    "pnpm store prune stopped at its 10 minute limit. 4.0G free.",
    "uv cache prune failed with exit 1: error: cache is locked. 4.0G free.",
    "go clean -cache: done. 4.0G free.",
    "Still 4.0G free, below the 10G alert floor. Nothing else is removed.",
  ]);
});

test("the sweep stops once free space is back above the floor", async () => {
  const run = sweep({}, { fleet: 6, pnpm: 6 });
  expect(await diskSweep(run.options)).toBe(0);
  expect(run.ran).toEqual([`sh ${launcher} prune`, `trim ${bootLog} 100M 20M`, "pnpm store prune"]);
  expect(run.logged.slice(-2)).toEqual(["pnpm store prune: done. 16.0G free.", "16.0G free, above the 15G floor, so the sweep stops."]);
  expect(run.printed).toEqual([]);
  const roomy = sweep({ free: () => 40 * gigabyte });
  await diskSweep(roomy.options);
  expect(roomy.ran).toEqual([]);
});

test("above the alert floor nothing is listed; below it, the report ends with the ten largest folders under $HOME from a read-only du", async () => {
  const between = sweep({}, { fleet: 8 });
  await diskSweep(between.options);
  expect(between.ran.at(-1)).toBe("go clean -cache");
  expect(between.printed).toEqual([]);
  const low = sweep();
  await diskSweep(low.options);
  expect(low.ran.at(-1)).toBe(`du -x -k -d 2 ${home}`);
  expect(low.printed).toEqual([[
    "The largest folders under $HOME, for you to decide:",
    `30.0G ${home}/.cache`, `20.0G ${home}/.cache/uv`, `12.0G ${home}/dev`, `11.0G ${home}/dev/big`, `9.0G ${home}/.t3`,
    `8.0G ${home}/.t3/worktrees`, `5.0G ${home}/notes`, `4.0G ${home}/.bun`, `3.0G ${home}/.bun/install`, `2.0G ${home}/go`,
  ].join("\n")]);
  const slow = sweep({ run: async (argv) => (argv[0] === "du" ? { code: 124, stdout: `${20 * 1024 * 1024}\t${home}/.cache\n`, stderr: "" } : done) });
  await diskSweep(slow.options);
  expect(slow.printed).toEqual([`The largest folders under $HOME, for you to decide:\n20.0G ${home}/.cache\ndu did not finish in 5 minutes, so the list may miss folders.`]);
});

test("a dry run lists the cleaners it would run, and runs none", async () => {
  const run = sweep({ dryRun: true, installed: (tool) => tool !== "go" });
  expect(await diskSweep(run.options)).toBe(0);
  expect([run.ran, run.printed]).toEqual([[], []]);
  expect(run.logged).toEqual([
    "Sweep (dry run): 4.0G free, floor 15G.",
    "Would run fleet prune.",
    "Would run trim the T3 boot log.",
    "Would run pnpm store prune.",
    "Would run uv cache prune.",
    "Skipped go clean -cache: go is not installed.",
  ]);
});

function stubTools(dir: string) {
  mkdirSync(dir, { recursive: true });
  const script = (name: string, body: string) => (writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${dir}/calls.log"\n${body}\n`), chmodSync(join(dir, name), 0o755));
  script("pnpm", "");
  script("uv", "exit 1");
  for (const tool of ["sh", "du"]) symlinkSync(`/usr/bin/${tool}`, join(dir, tool));
  return dir;
}

test("fleet disk-sweep runs the installed cleaners from PATH and the engine launcher, takes its floors from its arguments, and lists the largest folders", async () => {
  const sandbox = temp.make("sweep-home-");
  const bin = stubTools(join(sandbox, "bin"));
  mkdirSync(join(sandbox, "engine"));
  writeFileSync(join(sandbox, "engine/fleet"), `echo "fleet $*" >> "${bin}/calls.log"`);
  mkdirSync(join(sandbox, "data/inner"), { recursive: true });
  const env = { HOME: sandbox, PATH: bin, FLEET_ENGINE_DIR: join(sandbox, "engine"), FLEET_SETTINGS: JSON.stringify({ "base.diskFloorGigabytes": 10 }) };
  const lines: string[] = [];
  const code = await diskSweepCommand(["--floor", "1000000", "--alert-floor", "1000000"], { home: sandbox, env, log: (line) => lines.push(line), print: (line) => lines.push(line) });
  expect(code).toBe(0);
  expect(readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n")).toEqual(["fleet prune", "pnpm store prune", "uv cache prune"]);
  expect(lines).toContain("Skipped go clean -cache: go is not installed.");
  expect(lines.some((line) => line.startsWith("uv cache prune failed with exit 1"))).toBe(true);
  expect(lines.at(-1)).toContain(`${sandbox}/data/inner`);
});

test("fleet disk-sweep takes only --dry-run and its two floors", async () => {
  const usage = "Usage: fleet disk-sweep [--dry-run] [--floor <gigabytes>] [--alert-floor <gigabytes>]";
  await expect(diskSweepCommand(["--all"], { home: "/nowhere", env: {} })).rejects.toThrow(usage);
  await expect(diskSweepCommand(["--floor"], { home: "/nowhere", env: {} })).rejects.toThrow(usage);
  await expect(diskSweepCommand(["--floor", "lots"], { home: "/nowhere", env: {} })).rejects.toThrow(usage);
});

test("the Disk watch risk text names each removal the sweep can make, and each one it never makes", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../pack.json"), "utf8")) as { workflows: Array<{ id: string; risk?: string }> };
  const risk = manifest.workflows.find((workflow) => workflow.id === "disk-watch")!.risk!;
  const [removes, never] = risk.split("It never");
  for (const removal of [
    "fleet prune", "idle for 6 hours, or 24", "on the default branch", "merged pull request", "T3 thread is closed", "agent has been idle for a day",
    "lockfile and tool output changes", "Git no longer tracks", "boot log over 100 MB", "pnpm store prune", "uv cache prune", "go clean -cache",
  ]) expect(removes).toContain(removal);
  for (const untouched of ["Nix garbage", "Cargo build output", "uv cache folder", "old T3 versions", "Docker", "Bun's cache"]) expect(never).toContain(untouched);
  expect(risk).toContain("It deletes no other file.");
});
