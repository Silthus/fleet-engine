import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../base/lib/command.ts";
import { stringSetting } from "../../base/lib/settings.ts";
import { forgetIdleClaims } from "../lib/notes.ts";
import { refreshTriggers } from "../lib/triggers.ts";

export function memoryUrl(repo: string) {
  return repo.includes("://") || repo.includes("@") ? repo : `https://github.com/${repo}.git`;
}

export async function syncMemory(env: Record<string, string | undefined> = Bun.env) {
  const repo = stringSetting("memory.repo", env);
  if (!repo) throw new Error("memory.repo is empty. Set it with fleet set memory.repo=<owner>/<repo>.");
  const child = Bun.spawn(["sh", join(import.meta.dir, "../sync/sync.sh")], { stdio: ["inherit", "inherit", "inherit"], env: { ...env, FLEET_MEMORY_URL: memoryUrl(repo) } });
  const code = await child.exited;
  const home = env.HOME ?? homedir();
  try {
    refreshTriggers(home);
    forgetIdleClaims(home);
  } catch (error) {
    console.error(`Memory: cannot refresh the trigger table: ${error instanceof Error ? error.message : error}`);
  }
  return code;
}

if (import.meta.main) await runCommand(() => syncMemory(), "fleet memory-sync");
