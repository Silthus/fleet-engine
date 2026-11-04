import { secretKinds } from "../../base/hooks/secret-guard.ts";

function git(checkout: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", checkout, ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

export function outgoingText(checkout: string, range: string[]) {
  const fields = git(checkout, ["log", "--format=", "--raw", "-m", "-z", "--no-abbrev", "--no-renames", "--root", ...range]).toString().split("\0");
  const parts: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const blob = fields[index]!.trim().split(" ")[3] ?? "";
    parts.push(fields[index + 1]!);
    if (!/^0*$/.test(blob)) parts.push(git(checkout, ["cat-file", "blob", blob]).toString("latin1"));
  }
  return parts.join("\n");
}

if (import.meta.main) {
  const [checkout, ...range] = Bun.argv.slice(2);
  try {
    const kinds = secretKinds(outgoingText(checkout!, range));
    if (kinds.length) console.error(`Secret scan: found ${kinds.join(", ")}`);
    process.exit(kinds.length ? 1 : 0);
  } catch (error) {
    console.error(`Secret scan: ${(error as Error).message}`);
    process.exit(2);
  }
}
