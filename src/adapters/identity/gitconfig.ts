import { join } from "node:path";
import type { Identity } from "./github.ts";
import type { Signer } from "./signers.ts";

export const fleetGitconfig = ".config/fleet/gitconfig";
export const allowedSigners = ".ssh/fleet-allowed-signers";
export const includeBlock = `[include]\n\tpath = ~/${fleetGitconfig}\n`;

const value = (text: string) => `"${text.replace(/[\\"]/g, (character) => `\\${character}`).replaceAll("\n", "\\n")}"`;

export function gitconfig(home: string, identity: Identity, signer: Signer) {
  return [
    "[user]",
    `\tname = ${value(identity.name)}`,
    `\temail = ${value(identity.email)}`,
    `\tsigningkey = ${value(join(home, signer.publicKey))}`,
    "[gpg]",
    "\tformat = ssh",
    '[gpg "ssh"]',
    `\tallowedSignersFile = ${value(join(home, allowedSigners))}`,
    ...(signer.program ? [`\tprogram = ${value(signer.program)}`] : []),
    ...(signer.sshCommand ? ["[core]", `\tsshCommand = ${value(signer.sshCommand)}`] : []),
    "[commit]",
    "\tgpgsign = true",
    "[tag]",
    "\tgpgsign = true",
    "",
  ].join("\n");
}

/** The user's .gitconfig with Fleet's include as its last section, so Fleet's identity wins over sections added later. */
export function withInclude(text = "") {
  if (text.endsWith(includeBlock)) return text;
  const rest = text.replace(includeBlock, "");
  return `${rest}${rest && !rest.endsWith("\n") ? "\n" : ""}${includeBlock}`;
}
