import { constants } from "node:fs";
import { access, lstat, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const fleetCargoConfig = "[net]\ngit-fetch-with-cli = true\n";

const usage = "usage: fleet cargo-git-cli [--check]";

type Cargo = { home: string; cargoHome?: string };

export async function cargoGitCliCommand(args: string[], cargo: Cargo): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error(usage);
  const dir = cargo.cargoHome || join(cargo.home, ".cargo");
  if (!(await needsConfig(dir))) return 0;
  if (args[0] === "--check") return 1;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.toml"), fleetCargoConfig);
  return 0;
}

async function needsConfig(dir: string) {
  for (const name of ["config.toml", "config"]) if (await present(join(dir, name))) return false;
  const found = await stat(dir).catch(() => undefined);
  if (found && !found.isDirectory()) return false;
  return writable(found ? dir : await nearestExisting(dirname(dir)));
}

const present = (path: string) => lstat(path).then(() => true, () => false);
const writable = (path: string) => access(path, constants.W_OK).then(() => true, () => false);

async function nearestExisting(path: string): Promise<string> {
  return (await present(path)) || dirname(path) === path ? path : nearestExisting(dirname(path));
}
