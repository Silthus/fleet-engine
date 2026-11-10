import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedSigners, listText, parseOwners, systemPaths, verify, type Verdict } from "./allowlist.ts";

export type AllowlistInputs = { settings: Record<string, unknown>; profileDir?: string; root: string; print: (line: string) => void };

const usage = "usage: fleet guards allowlist [text | stage <folder> | --check]";
const installScript = join(import.meta.dir, "../system/install.sh");

/** The profile keeps the signature beside fleet.json, so every machine of the profile installs the same signed list. */
export const signatureFile = (profileDir: string) => join(profileDir, "guards/git-allowlist.sig");

function signedList(inputs: AllowlistInputs) {
  const owners = parseOwners(String(inputs.settings["guards.owners"] ?? ""));
  if (owners.length === 0) throw new Error("guards.owners names no owner. Set it with fleet set guards.owners=<owner>,<owner>.");
  const signers = allowedSigners(String(inputs.settings["guards.signers"] ?? ""));
  if (!signers) throw new Error("guards.signers names no signing key. Set it to the SSH public key that signs the list.");
  if (!inputs.profileDir) throw new Error("this machine has no profile, which holds the list's signature.");
  return { owners, text: listText(owners), signers, signature: signatureFile(inputs.profileDir) };
}

function verifyWith(list: ReturnType<typeof signedList>): Verdict {
  const work = mkdtempSync(join(tmpdir(), "fleet-allowlist-"));
  try {
    writeFileSync(join(work, "signers"), list.signers);
    return verify(list.text, list.signature, join(work, "signers"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const readOr = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

function installedState(root: string, text: string) {
  const paths = systemPaths(root);
  const includes = Bun.spawnSync(["git", "config", "--file", paths.gitconfig, "--get-all", "include.path"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().split("\n");
  if (![paths.signers, paths.config, paths.helper].every(existsSync) || !includes.includes(paths.config)) return "not installed";
  return readOr(paths.list) === text ? "installed" : "installed with another list";
}

function stage(list: ReturnType<typeof signedList>, folder: string) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, "git-allowlist"), list.text);
  writeFileSync(join(folder, "git-allowlist-signers"), list.signers);
  copyFileSync(list.signature, join(folder, "git-allowlist.sig"));
  copyFileSync(installScript, join(folder, "install.sh"));
}

/** Prints the signed Git allowlist and whether it verifies and is installed, stages it for the root step, or checks it for doctor. */
export function allowlistCommand(args: string[], inputs: AllowlistInputs): number {
  const [mode, folder, ...rest] = args;
  if (rest.length || (mode === "stage") !== Boolean(folder) || ![undefined, "text", "stage", "--check"].includes(mode)) throw new Error(usage);
  const list = signedList(inputs);
  if (mode === "text") return inputs.print(list.text.trimEnd()), 0;
  const verdict = verifyWith(list);
  const installed = installedState(inputs.root, list.text);
  if (mode === "--check") return verdict.ok && installed === "installed" ? 0 : 1;
  if (mode === "stage") {
    if (!verdict.ok) throw new Error(`the Git allowlist was not staged, because ${verdict.reason}`);
    stage(list, folder!);
    inputs.print(`Staged the signed Git allowlist in ${folder}. Install it with: sudo sh ${join(folder!, "install.sh")}`);
    return 0;
  }
  inputs.print(`Git allowlist from guards.owners: ${list.owners.join(", ")}`);
  inputs.print(verdict.ok ? `Signature ${list.signature}: verified.` : `Signature ${list.signature}: not verified, because ${verdict.reason}. Sign the exact text of fleet guards allowlist text with a key from guards.signers: fleet guards allowlist text > list && ssh-keygen -Y sign -f <your key> -n fleet-git-allowlist list, then save list.sig as ${list.signature}.`);
  inputs.print(`System: ${installed}.`);
  return verdict.ok ? 0 : 1;
}
