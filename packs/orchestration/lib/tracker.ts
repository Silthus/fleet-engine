const githubOrigin = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

export function mapTracker(setting: string | undefined, profileDir: string | undefined): string {
  if (setting) return setting;
  if (!profileDir) return "";
  const origin = Bun.spawnSync(["git", "-C", profileDir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
  const match = origin.exitCode === 0 ? origin.stdout.toString().trim().match(githubOrigin) : null;
  return match ? `${match[1]}/${match[2]}` : "";
}
