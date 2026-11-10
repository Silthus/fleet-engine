import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const sessionTarget = ".config/fleet/session.sh";
export const sourceLine = `[ -r "$HOME/${sessionTarget}" ] && . "$HOME/${sessionTarget}"`;

const usage = "usage: fleet shell-session [--check]";

export async function shellSessionCommand(args: string[], home: string): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error(usage);
  const lacking: Array<{ file: string; text: string }> = [];
  for (const file of [".bashrc", bashLoginFile(home)].map((name) => join(home, name))) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (!text.split("\n").includes(sourceLine)) lacking.push({ file, text });
  }
  if (!lacking.length) return 0;
  if (args[0] === "--check") return 1;
  for (const { file, text } of lacking) await writeFile(file, `${sourceLine}\n${text}`);
  return 0;
}

function bashLoginFile(home: string) {
  return [".bash_profile", ".bash_login"].find((name) => existsSync(join(home, name))) ?? ".profile";
}
