import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "../pack/manifest.ts";
import type { FetchedSource, SourceRef } from "../pack/types.ts";
import { isolateGit, tempDirs } from "../testing/git.ts";
import { fakeMachine, fleetSetup, machineFile } from "./testing.ts";
import { timingsPath, type Timings } from "./timings.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const start = Date.parse("2026-11-11T10:00:00Z");
function teamSource(): (ref: SourceRef) => Promise<FetchedSource> {
  const dir = temp.make("team-");
  mkdirSync(join(dir, "packs/posthog"), { recursive: true });
  writeFileSync(join(dir, "packs/posthog/pack.json"), JSON.stringify({ schema: 1, name: "posthog", summary: "Team repo prep.", human: [{ id: "coder", say: "Sign in to Coder", command: "coder login", probe: ["coder", "whoami"], interactive: true }] }));
  return async (ref) => ({ ref, dir, packs: await loadPacks(dir) });
}

const timings = (home: string) => JSON.parse(readFileSync(timingsPath(home), "utf8")) as Timings;

describe("fleet setup --chat", () => {
  test("asks nothing, and waits for each browser sign-in in the same run", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, { github: 3, claude: 2 }, { startedAt: start });
    const result = await fleetSetup(home, ["--chat", "--preset", "starter", "--plan", "claude", "--devbox", "skip"], [], box);
    expect(result.code).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(box.opened).toEqual(["https://github.com/login/device"]);
    expect(result.output).not.toContain("Needs you");
    expect(result.output).toContain("  ✓ Sign in to GitHub: done");
    expect(result.output).toContain("  ✓ Sign in to Claude: done");
    expect(machineFile(home).setup.done).toContain("check");
  });

  test("leaves a sign-in that needs the keyboard open, and says to run it in a terminal, once the machine is usable", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, { coder: 50 }, { org: true, startedAt: start });
    const result = await fleetSetup(home, ["--chat", "--plan", "claude", "--devbox", "skip"], [], box, teamSource());
    expect(result.code).toBe(2);
    expect(box.runs).toEqual([]);
    expect(result.output).toContain("✓ Ready to use. Start a new thread in T3 Code now. Setup goes on with: Sign in to Coder, Check everything.");
    expect(result.output).toContain("  In a terminal, run: sh -c 'coder login'");
    expect(timings(home).usable).toBe("2026-11-11T10:00:00.000Z");
  });
});

describe("usable before the rest", () => {
  test("with both plans, the machine is usable once Claude passes, and ChatGPT and the final check follow", async () => {
    const home = temp.make("home-");
    const box = fakeMachine(home, { github: 3, chatgpt: 4 }, { startedAt: start });
    const result = await fleetSetup(home, ["--chat", "--preset", "starter", "--plan", "both", "--devbox", "skip"], [], box);
    expect(result.code).toBe(0);
    const ready = result.output.indexOf("✓ Ready to use. Start a new thread in T3 Code now. Setup goes on with: Install Codex, Sign in to ChatGPT, Check everything.");
    expect(ready).toBeGreaterThan(result.output.indexOf("  ✓ Sign in to Claude: already done"));
    expect(ready).toBeLessThan(result.output.indexOf("▶ Install Codex"));
    expect(result.output.indexOf("▶ Install Codex")).toBeLessThan(result.output.indexOf("▶ Sign in to ChatGPT"));
    expect(result.skipped).toEqual([["base/codex-cli"], []]);
    expect(result.output).toContain("  Ready after     6s\n");
    expect(timings(home).usableSeconds).toBe(6);
    expect(timings(home).steps.at(-1)).toMatchObject({ id: "check", outcome: "done", end: "2026-11-11T10:00:14.000Z" });
  });

  test("without a person to wait for, installs Codex in the first apply, since the run stops at an open sign-in", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "both", "--devbox", "skip"], [], fakeMachine(home, { claude: 5 }, { startedAt: start }));
    expect(result.code).toBe(2);
    expect(result.skipped).toEqual([[]]);
    expect(result.output).not.toContain("Install Codex");
  });

  test("with one plan, installs everything in one apply", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, ["--chat", "--preset", "starter", "--plan", "codex", "--devbox", "skip"], [], fakeMachine(home, {}, { startedAt: start }));
    expect(result.code).toBe(0);
    expect(result.skipped).toEqual([[]]);
    expect(result.output).not.toContain("Install Codex");
  });

  test("asks the devbox question before the steps that can wait", async () => {
    const home = temp.make("home-");
    const result = await fleetSetup(home, ["--preset", "starter", "--plan", "both"], ["", "", ""], fakeMachine(home, { chatgpt: 1 }, { startedAt: start }));
    expect(result.code).toBe(0);
    expect(result.output.indexOf("No devbox for now")).toBeLessThan(result.output.indexOf("✓ Ready to use"));
    expect(result.output.indexOf("✓ Ready to use")).toBeLessThan(result.output.indexOf("▶ Sign in to ChatGPT"));
  });
});
