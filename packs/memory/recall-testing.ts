import { afterEach, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { main } from "../../src/cli.ts";
import { git, gitEnv, tempDirs } from "../../src/testing/git.ts";

export const temp = tempDirs();
afterEach(() => temp.cleanup());

const engineRoot = join(import.meta.dir, "../..");
const launcher = join(engineRoot, "fleet");
export type Provider = "claude" | "codex";

export async function fleet(args: string[], home: string) {
  const runFleetStepsOnly = async (command: string[]) => (command[1] === launcher ? fleet(command.slice(2), home) : 0);
  return main(args, { home, engineRoot, platform: "linux", env: {}, print: () => {}, run: runFleetStepsOnly });
}

export async function machineWithMemory(notes: Record<string, string>, repo = "me/notes", extra: Record<string, string> = {}) {
  const home = temp.make("home-");
  const profile = temp.make("profile-");
  const settings = { "memory.repo": repo, ...extra };
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [], packs: ["memory"], plan: "both", settings, workflows: {} }));
  expect(await fleet(["apply", "--profile", profile], home)).toBe(0);
  for (const [path, text] of Object.entries(notes)) {
    mkdirSync(dirname(join(home, ".agents/memory", path)), { recursive: true });
    writeFileSync(join(home, ".agents/memory", path), text);
  }
  return home;
}

export function repoCheckout(home: string, origin: string) {
  const dir = join(home, "code", "checkout");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", origin);
  return dir;
}

export function installedHook(home: string, provider: Provider, event: string) {
  const config = provider === "claude" ? JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")) : parseToml(readFileSync(join(home, ".codex/config.toml"), "utf8"));
  return (config.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)[event]![0]!.hooks[0]!.command;
}

export async function fire(home: string, provider: Provider, event: string, input: Record<string, unknown>) {
  const child = Bun.spawn(["sh", "-c", installedHook(home, provider, event)], {
    env: { ...gitEnv, PATH: Bun.env.PATH, HOME: home },
    stdin: new Blob([JSON.stringify({ hook_event_name: event, ...input })]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stderr, context: stdout.trim() ? (JSON.parse(stdout).hookSpecificOutput?.additionalContext as string | undefined) ?? "" : "" };
}

export const shownLog = (home: string, session: string) =>
  readFileSync(join(home, ".local/state/fleet/memory/shown", `${session}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));

export const proofTraps = "---\nname: proof-traps\ntriggers: [fleet proof, \"gh search\"]\n---\n\nPass full SHAs to fleet proof.\n";
export const flakySync = "---\nname: flaky-sync\nmetadata:\n  triggers:\n    - sync-retry\n---\n\nRetry the sync test once.\n";
export const notes = { "MEMORY.md": "# Memory index\n", "proof-traps.md": proofTraps, "projects/notes-app/flaky-sync.md": flakySync };
export const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
