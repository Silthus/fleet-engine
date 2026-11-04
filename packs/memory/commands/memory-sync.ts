import { join } from "node:path";
import { runCommand } from "../../base/lib/command.ts";
import { stringSetting } from "../../base/lib/settings.ts";

export function memoryUrl(repo: string) {
  return repo.includes("://") || repo.includes("@") ? repo : `https://github.com/${repo}.git`;
}

export async function syncMemory(env: Record<string, string | undefined> = Bun.env) {
  const repo = stringSetting("memory.repo", env);
  if (!repo) throw new Error("memory.repo is empty. Set it with fleet set memory.repo=<owner>/<repo>.");
  const child = Bun.spawn(["sh", join(import.meta.dir, "../sync/sync.sh")], { stdio: ["inherit", "inherit", "inherit"], env: { ...env, FLEET_MEMORY_URL: memoryUrl(repo) } });
  return child.exited;
}

if (import.meta.main) await runCommand(() => syncMemory(), "fleet memory-sync");
