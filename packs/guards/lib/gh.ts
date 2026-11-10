import { commandsIn } from "./shell-words.ts";

const keyReason = (person: string) => `Fleet blocked this command: it changes the SSH or GPG keys on ${person}'s GitHub account, which gives lasting access. If you need it, stop and ask ${person}.`;
const tokenReason = (person: string) => "Fleet blocked this command: it signs in to GitHub, or prints or widens the GitHub token. "
  + `Use \`gh\` or \`gh auth git-credential\`, which use the token without showing it. If you need a new sign-in or scope, stop and ask ${person} to run it.`;
const extensionReason = (person: string) => `Fleet blocked this command: a gh extension is code from a GitHub repository that runs with the GitHub token. If you need it, stop and ask ${person}.`;
const exposureReason = (person: string) => `Fleet blocked this command: it deletes a repository or makes code public. If you need it, stop and ask ${person}.`;
const ownerReason = (owner: string, person: string) => `Fleet blocked this command: \`${owner}\` is not one of the GitHub owners agents may use on this machine. `
  + `Use a repository of an allowed owner, or stop and ask ${person} to add \`${owner}\` to guards.owners.`;

const tokenSubstitution = /(?:\$\(|`)\s*gh\s+auth\s+token\b/;
const accountEndpoints = /^\/?(?:user\/(?:keys|ssh_signing_keys|gpg_keys)|authorizations)\b/;
const repositoryEndpoint = /^\/?repos\/[^/]+\/[^/]+\/?$/;
const ownerEndpoint = /^(?:https:\/\/api\.github\.com)?\/?(?:repos|orgs)\/([^/{?]+)/;
const githubUrl = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\//;
const repoSubcommands = new Set(["clone", "view", "fork", "edit", "delete", "sync", "archive", "unarchive", "rename", "create", "set-default"]);
const ownerFlags = ["-R", "--repo", "--owner"];

const flagValue = (args: string[], flags: string[]) => args.flatMap((arg, index) =>
  flags.includes(arg) ? [args[index + 1] ?? ""] : flags.filter((flag) => arg.startsWith(`${flag}=`)).map((flag) => arg.slice(flag.length + 1)));

function exposure([group, action, ...rest]: string[], person: string): string | undefined {
  if ((group === "ssh-key" || group === "gpg-key") && (action === "add" || action === "delete")) return keyReason(person);
  if (group === "auth" && (action === "login" || action === "token" || action === "refresh")) return tokenReason(person);
  if ((group === "extension" || group === "ext") && (action === "install" || action === "upgrade")) return extensionReason(person);
  const visibility = flagValue(rest, ["--visibility"]);
  if (group === "repo" && (action === "delete" || (action === "create" && rest.includes("--public")) || (action === "edit" && visibility.includes("public")))) return exposureReason(person);
  if (group === "gist" && action === "create" && (rest.includes("--public") || rest.includes("-p"))) return exposureReason(person);
  if (group !== "api") return undefined;
  const args = [action, ...rest].filter((arg): arg is string => arg !== undefined);
  const methods = flagValue(args, ["-X", "--method"]);
  const endpoint = args.find((arg) => !arg.startsWith("-") && !methods.includes(arg)) ?? "";
  if (accountEndpoints.test(endpoint)) return keyReason(person);
  if (methods[0]?.toUpperCase() === "DELETE" && repositoryEndpoint.test(endpoint)) return exposureReason(person);
  return undefined;
}

function owners([group, action, ...rest]: string[]): string[] {
  const args = [action, ...rest].filter((arg): arg is string => arg !== undefined);
  const found = flagValue(args, ownerFlags).map((value) => value.replace(/^github\.com\//, "").split("/")[0]);
  for (const arg of args) {
    const url = arg.match(githubUrl);
    if (url) found.push(url[1]);
  }
  if (group === "repo" && repoSubcommands.has(action ?? "")) {
    const target = rest.find((arg) => !arg.startsWith("-") && arg.includes("/") && !githubUrl.test(arg));
    if (target) found.push(target.split("/")[0]);
  }
  if (group === "api") {
    const endpoint = args.find((arg) => ownerEndpoint.test(arg));
    if (endpoint) found.push(endpoint.match(ownerEndpoint)![1]);
  }
  return found.filter((owner) => owner && !/^[{$:]/.test(owner));
}

/** Parses guards.owners, a list of GitHub owners separated by commas or spaces. No list means no owner rule. */
export function ownerList(value: unknown): Set<string> | null {
  const names = typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean).map((name) => name.toLowerCase()) : [];
  return names.length ? new Set(names) : null;
}

/** Refuses gh commands that sign in, show or widen the token, change account keys, run extensions, delete or publish
 * code, or name a repository whose owner is not allowed. */
export function ghRisk(command: string, allowed: ReadonlySet<string> | null, person: string): string | undefined {
  if (tokenSubstitution.test(command)) return tokenReason(person);
  for (const { name, args } of commandsIn(command)) {
    if (name !== "gh") continue;
    const risk = exposure(args, person);
    if (risk) return risk;
    const outside = allowed && owners(args).find((owner) => !allowed.has(owner.toLowerCase()));
    if (outside) return ownerReason(outside, person);
  }
  return undefined;
}
