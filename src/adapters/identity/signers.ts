import { join } from "node:path";
import type { Os } from "../../pack/types.ts";
import { quote } from "../jobs/launcher.ts";
import type { KeyType } from "./github.ts";

export const signerSetting = "identity.signer";
export const signerNames = ["ssh", "coder", "1password"] as const;
export type SignerName = (typeof signerNames)[number];

export type Signer = {
  name: SignerName;
  publicKey: string;
  register: KeyType[];
  program?: string;
  sshCommand?: string;
};

export const sshKeyTarget = ".ssh/fleet_ed25519";
export const coderKeyTarget = ".ssh/fleet-coder-git.pub";
export const onePasswordKeyTarget = ".config/fleet/signing-key.pub";

const onePasswordPrograms: Record<Os, string> = { darwin: "/Applications/1Password.app/Contents/MacOS/op-ssh-sign", linux: "/opt/1Password/op-ssh-sign" };

export const coderScript = (engineRoot: string) => join(engineRoot, "scripts/coder-git-key.sh");

export function signer(name: SignerName, home: string, os: Os, engineRoot: string): Signer {
  if (name === "coder") return { name, publicKey: coderKeyTarget, register: ["signing"], program: coderScript(engineRoot), sshCommand: `${quote(coderScript(engineRoot))} ssh` };
  if (name === "1password") return { name, publicKey: onePasswordKeyTarget, register: ["authentication", "signing"], program: onePasswordPrograms[os] };
  return { name, publicKey: `${sshKeyTarget}.pub`, register: ["authentication", "signing"], sshCommand: `ssh -i ${quote(join(home, sshKeyTarget))}` };
}
