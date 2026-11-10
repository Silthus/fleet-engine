import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const signerIdentity = "fleet-allowlist";
export const signatureNamespace = "fleet-git-allowlist";

/** Where the root-owned allowlist lives under a system root, which is / on a real machine. */
export const systemPaths = (root: string) => ({
  dir: join(root, "etc/fleet"),
  list: join(root, "etc/fleet/git-allowlist"),
  signature: join(root, "etc/fleet/git-allowlist.sig"),
  signers: join(root, "etc/fleet/git-allowlist-signers"),
  config: join(root, "etc/fleet/git-allowlist.gitconfig"),
  helper: join(root, "usr/local/bin/git-remote-fleet-blocked"),
  sshCheck: join(root, "usr/local/bin/fleet-git-ssh"),
  gitconfig: join(root, "etc/gitconfig"),
});

const ownerName = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** The owners of a list, one per line or separated by commas or spaces; # starts a comment line. */
export function parseOwners(text: string): string[] {
  const owners = text.split("\n").filter((line) => !line.trim().startsWith("#")).flatMap((line) => line.split(/[\s,]+/)).filter(Boolean);
  for (const owner of owners) if (!ownerName.test(owner)) throw new Error(`${JSON.stringify(owner)} is not a GitHub owner name`);
  return [...new Set(owners)];
}

/** The exact bytes a person signs: one owner per line, in the order guards.owners gives them. */
export const listText = (owners: string[]) => owners.map((owner) => `${owner}\n`).join("");

/** The allowed-signers file ssh-keygen reads, from guards.signers: one SSH public key per line. */
export function allowedSigners(keys: string): string {
  const lines = keys.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  for (const line of lines) if (!/^(?:ssh|ecdsa|sk)-[\w@.-]+ [A-Za-z0-9+/=]+(?: .*)?$/.test(line)) throw new Error(`guards.signers has a line that is not an SSH public key: ${JSON.stringify(line.slice(0, 40))}`);
  return lines.map((line) => `${signerIdentity} namespaces="${signatureNamespace}" ${line}\n`).join("");
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Checks the list's bytes against the signers with ssh-keygen, so a change to either file breaks the check. */
export function verify(list: string, signature: string, signersFile: string): Verdict {
  if (!existsSync(signature)) return { ok: false, reason: `there is no signature at ${signature}` };
  const checked = Bun.spawnSync(["ssh-keygen", "-Y", "verify", "-f", signersFile, "-I", signerIdentity, "-n", signatureNamespace, "-s", signature], {
    stdin: new TextEncoder().encode(list),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  if (checked.exitCode === 0) return { ok: true };
  const said = `${checked.stderr.toString()}${checked.stdout.toString()}`.trim().split("\n")[0];
  return { ok: false, reason: `the signature does not verify: ${said || `ssh-keygen exited ${checked.exitCode}`}` };
}

/** The owners of the installed list, or null when no list is installed. Root owns the file and wrote it only after it verified. */
export function installedOwners(root: string): Set<string> | null {
  try {
    return new Set(parseOwners(readFileSync(systemPaths(root).list, "utf8")).map((owner) => owner.toLowerCase()));
  } catch {
    return null;
  }
}
