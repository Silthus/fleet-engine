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

const fleetPath = new RegExp(`^\\s*path\\s*=\\s*~/${fleetGitconfig.replaceAll(".", "\\.")}\\s*$`);
const header = /^\s*\[/;

export function withInclude(text = "") {
  const lines = text.split("\n");
  const ours = (index: number) => fleetPath.test(lines[index]!) && lines[headerOf(lines, index)]?.trim().toLowerCase() === "[include]";
  const count = lines.filter((_, index) => ours(index)).length;
  if (text.endsWith(includeBlock) && count === 1) return text;
  const emptied = new Set(lines.flatMap((_, index) => (ours(index) ? [headerOf(lines, index)] : [])));
  const onlyOurs = (index: number) => lines.slice(index + 1, nextHeader(lines, index)).every((line, offset) => ours(index + 1 + offset) || !line.trim() || /^\s*[#;]/.test(line));
  const rest = lines.filter((_, index) => !ours(index) && !(emptied.has(index) && onlyOurs(index))).join("\n");
  return `${rest}${rest && !rest.endsWith("\n") ? "\n" : ""}${includeBlock}`;
}

function headerOf(lines: string[], index: number) {
  for (let at = index; at >= 0; at--) if (header.test(lines[at]!)) return at;
  return -1;
}

function nextHeader(lines: string[], index: number) {
  const found = lines.findIndex((line, at) => at > index && header.test(line));
  return found === -1 ? lines.length : found;
}
