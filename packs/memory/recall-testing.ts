import { afterAll, afterEach, expect } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { main } from "../../src/cli.ts";
import { gitEnv, spawnGit, tempDirs } from "../../src/testing/git.ts";
import { check as nameAModelCheck } from "../base/hooks/name-a-model.ts";
import { dispatch, type HookResult, type RunHook } from "../base/hooks/run.ts";
import { guard as secretGuard } from "../base/hooks/secret-guard.ts";
import { check as memoryCapCheck } from "./hooks/memory-cap.ts";
import { sessionIndexes } from "./hooks/memory-index.ts";
import { recallNotes } from "./hooks/memory-recall.ts";
import type { HookInput } from "./lib/notes.ts";

const engineRoot = join(import.meta.dir, "../..");
const launcher = join(engineRoot, "fleet");
export type Provider = "claude" | "codex";

export async function fleet(args: string[], home: string) {
  const runFleetStepsOnly = async (command: string[]) => (command[1] === launcher ? fleet(command.slice(2), home) : 0);
  return main(args, { home, engineRoot, platform: "linux", env: {}, print: () => {}, run: runFleetStepsOnly });
}

export function recallHarness() {
  const temp = tempDirs();
  const prepared = tempDirs();
  const appliedHomes = new Map<string, Promise<AppliedHome>>();
  afterEach(() => temp.cleanup());
  afterAll(() => prepared.cleanup());
  const machineWithMemory = async (notes: Record<string, string>, repo = "me/notes", extra: Record<string, string> = {}) => {
    const settings = { "memory.repo": repo, ...extra };
    const key = JSON.stringify(settings);
    if (!appliedHomes.has(key)) appliedHomes.set(key, applyMemoryPack(prepared, settings));
    const applied = await appliedHomes.get(key)!;
    expect(applied.code).toBe(0);
    return memoryMachine(copyHome(applied.home, temp.make("home-")), notes);
  };
  return { temp, machineWithMemory };
}

type AppliedHome = { home: string; code: number };

async function applyMemoryPack(prepared: ReturnType<typeof tempDirs>, settings: Record<string, string>): Promise<AppliedHome> {
  const home = prepared.make("home-");
  const profile = prepared.make("profile-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [], packs: ["memory"], plan: "both", settings, workflows: {} }));
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  symlinkSync(process.execPath, join(home, ".bun/bin/bun"));
  return { home, code: await fleet(["apply", "--profile", profile], home) };
}

function copyHome(from: string, to: string) {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  for (const entry of readdirSync(to, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const text = readFileSync(path, "utf8");
    if (text.includes(from)) writeFileSync(path, text.replaceAll(from, to));
  }
  return to;
}

function memoryMachine(home: string, notes: Record<string, string>) {
  for (const [path, text] of Object.entries(notes)) {
    mkdirSync(dirname(join(home, ".agents/memory", path)), { recursive: true });
    writeFileSync(join(home, ".agents/memory", path), text);
  }
  return home;
}

export async function repoCheckout(home: string, origin: string) {
  const dir = join(home, "code", "checkout");
  mkdirSync(dir, { recursive: true });
  await spawnGit(dir, "init", "-q");
  await spawnGit(dir, "remote", "add", "origin", origin);
  return dir;
}

export function installedHook(home: string, provider: Provider, event: string) {
  const config = provider === "claude" ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : parseToml(readFileSync(join(home, ".codex/config.toml"), "utf8"));
  return (config.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)[event]![0]!.hooks[0]!.command;
}

export async function fireInstalled(home: string, provider: Provider, event: string, input: Record<string, unknown>) {
  const child = Bun.spawn(["sh", "-c", installedHook(home, provider, event)], {
    env: { ...gitEnv, PATH: Bun.env.PATH, HOME: home },
    stdin: new Blob([hookInput(event, input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return answerOf({ code, stdout, stderr });
}

export async function fire(home: string, provider: Provider, event: string, input: Record<string, unknown>) {
  expect(installedHook(home, provider, event)).toBe(`sh "$HOME/.config/fleet/hooks/run.sh" ${provider} ${event}`);
  return answerOf(await dispatch(join(home, ".config/fleet/hooks", event), provider, hookInput(event, input), inProcess(home)));
}

const hookInput = (event: string, input: Record<string, unknown>) => JSON.stringify({ hook_event_name: event, ...input });

const answerOf = ({ code, stdout, stderr }: HookResult) => ({
  code,
  stderr,
  context: stdout.trim() ? (JSON.parse(stdout).hookSpecificOutput?.additionalContext as string | undefined) ?? "" : "",
});

type HookBody = (provider: Provider, input: string, home: string) => HookResult | Promise<HookResult>;

const quiet: HookResult = { code: 0, stdout: "", stderr: "" };
const refusing = (reason: string | undefined): HookResult => (reason ? { code: 2, stdout: "", stderr: `${reason}\n` } : quiet);
const printing = (answer: object | undefined): HookResult => (answer ? { code: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: "" } : quiet);

const answeringContext = (event: string, answer: (input: HookInput, provider: Provider, home: string) => Promise<string | undefined>): HookBody => async (provider, input, home) => {
  try {
    const context = await answer(JSON.parse(input) as HookInput, provider, home);
    return printing(context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : undefined);
  } catch {
    return quiet;
  }
};

const hookBodies: Record<string, HookBody> = {
  "memory-recall.ts": answeringContext("PreToolUse", (input, _, home) => recallNotes(input, home)),
  "memory-index.ts": answeringContext("SessionStart", sessionIndexes),
  "memory-cap.ts": (provider, input) => refusing(provider === "claude" ? memoryCapCheck(JSON.parse(input)) : undefined),
  "name-a-model.ts": (provider, input) => refusing(nameAModelCheck(provider, JSON.parse(input))),
  "secret-guard.ts": (provider, input) => printing(secretGuard(provider, JSON.parse(input))),
};

function inProcess(home: string): RunHook {
  return async (path, provider, input) => {
    const body = hookBodies[basename(path)];
    if (!body) return runInstalledFile(path, provider, input, home);
    try {
      return await body(provider as Provider, input, home);
    } catch (error) {
      return { code: 1, stdout: "", stderr: String(error) };
    }
  };
}

async function runInstalledFile(path: string, provider: string, input: string, home: string): Promise<HookResult> {
  const child = Bun.spawn([process.execPath, path, provider], { cwd: dirname(dirname(path)), env: { ...gitEnv, HOME: home }, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

export const shownLog = (home: string, session: string) =>
  readFileSync(join(home, ".local/state/fleet/memory/shown", `${session}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));

export const proofTraps = "---\nname: proof-traps\ntriggers: [fleet proof, \"gh search\"]\n---\n\nPass full SHAs to fleet proof.\n";
export const flakySync = "---\nname: flaky-sync\nmetadata:\n  triggers:\n    - sync-retry\n---\n\nRetry the sync test once.\n";
export const notes = { "MEMORY.md": "# Memory index\n", "proof-traps.md": proofTraps, "projects/notes-app/flaky-sync.md": flakySync };
export const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
