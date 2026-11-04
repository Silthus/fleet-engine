const scpOrigin = /^git@github\.com:([^/]+\/[^/]+)$/;
const repositoryPath = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export function mapTracker(setting: string | undefined, profileDir: string | undefined): string {
  if (setting) return setting;
  if (!profileDir) return "";
  const origin = Bun.spawnSync(["git", "-C", profileDir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
  return origin.exitCode === 0 ? githubRepository(origin.stdout.toString().trim()) ?? "" : "";
}

export function githubRepository(remote: string): string | undefined {
  const path = remote.match(scpOrigin)?.[1] ?? urlPath(remote);
  const match = path?.match(repositoryPath);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function urlPath(remote: string): string | undefined {
  const url = URL.parse(remote);
  if (!url || url.hostname !== "github.com" || url.search || url.hash) return undefined;
  if (url.protocol === "https:" && !url.port) return url.pathname.slice(1);
  if (url.protocol === "ssh:" && url.username === "git" && !url.password && (url.port === "" || url.port === "22")) return url.pathname.slice(1);
  return undefined;
}
