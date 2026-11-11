import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const fleetCargoConfig = "[net]\ngit-fetch-with-cli = true\n";

const usage = "usage: fleet cargo-git-cli [--check]";

export async function cargoGitCliCommand(args: string[], home: string, print: (line: string) => void): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error(usage);
  const cargo = join(home, ".cargo");
  const own = await firstPresent([join(cargo, "config.toml"), join(cargo, "config")]);
  if (own) {
    if (args[0] !== "--check" && !/^\s*git-fetch-with-cli\s*=\s*true\b/m.test(await readFile(own, "utf8").catch(() => ""))) print(`Fleet kept your ${own}. Add git-fetch-with-cli = true under [net], so Cargo fetches Git dependencies with Fleet's SSH command.`);
    return 0;
  }
  if (args[0] === "--check") return 1;
  await mkdir(cargo, { recursive: true });
  await writeFile(join(cargo, "config.toml"), fleetCargoConfig);
  return 0;
}

async function firstPresent(paths: string[]) {
  for (const path of paths) if (await lstat(path).then(() => true, () => false)) return path;
  return undefined;
}
