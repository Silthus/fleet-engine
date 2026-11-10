import { commandsIn } from "./shell-words.ts";

const keyReason = (person: string) => `Fleet blocked this command: it changes the SSH or GPG keys on ${person}'s GitHub account, which gives lasting access. If you need it, stop and ask ${person}.`;
const tokenReason = (person: string) => "Fleet blocked this command: it signs in to GitHub, or prints or widens the GitHub token. "
  + `Use \`gh\` or \`gh auth git-credential\`, which use the token without showing it. If you need a new sign-in or scope, stop and ask ${person} to run it.`;
const extensionReason = (person: string) => `Fleet blocked this command: a gh extension is code from a GitHub repository that runs with the GitHub token. If you need it, stop and ask ${person}.`;
const exposureReason = (person: string) => `Fleet blocked this command: it deletes a repository or makes code public. If you need it, stop and ask ${person}.`;
const ownerReason = (owner: string, person: string) => `Fleet blocked this command: \`${owner}\` is not one of the GitHub owners agents may use on this machine. `
  + `Use a repository of an allowed owner, or stop and ask ${person} to add \`${owner}\` to guards.owners.`;

type Gh = { group: string; action: string; operands: string[]; flags: Map<string, string[]> };

const valuedFlags: Record<string, string[]> = {
  any: ["-R", "--repo", "--org", "--owner", "-b", "--body", "-t", "--title", "-B", "--base", "-H", "--head", "-F", "--body-file", "-l", "--label",
    "-a", "--assignee", "-m", "--milestone", "-r", "--reviewer", "--json", "-q", "--jq", "--template", "-L", "--limit", "-s", "--state", "-A", "--author",
    "-e", "--env", "--app", "-n", "--notes", "--notes-file", "--target", "-p", "--pattern", "-D", "--dir", "-O", "--output", "--search", "-S",
    "--branch", "-h", "--hostname", "--visibility", "-o"],
  repo: ["-R", "--repo", "--org", "-d", "--description", "-h", "--homepage", "-t", "--team", "-p", "--template", "-g", "--gitignore", "-l", "--license",
    "-s", "--source", "-r", "--remote", "-u", "--upstream-remote-name", "-b", "--branch", "-L", "--limit", "-q", "--jq", "--json", "--visibility",
    "--language", "--topic", "--add-topic", "--remove-topic", "--default-branch", "--fork-name", "--remote-name"],
  api: ["-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview", "--hostname"],
  gist: ["-d", "--desc", "-f", "--filename", "-R", "--repo"],
};
const aliases: Record<string, string> = { new: "create", ls: "list", rm: "delete", ext: "extension", extensions: "extension" };
const shortValued = (valued: string[]) => new Set(valued.filter((flag) => /^-[A-Za-z]$/.test(flag)).map((flag) => flag[1]));
const accountEndpoints = /^(?:user\/(?:keys|ssh_signing_keys|gpg_keys)|authorizations)\b/;
const repositoryEndpoint = /^repos\/[^/]+\/[^/]+\/?$/;
const repositoryCreation = /^(?:user\/repos|orgs\/[^/]+\/repos|repos\/[^/]+\/[^/]+\/generate)\/?$/;
const ownerEndpoint = /^(?:repos|orgs)\/([^/{?]+)/;
const githubUrl = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)/;
const repoTargets = new Set(["clone", "view", "fork", "edit", "delete", "sync", "archive", "unarchive", "create", "set-default"]);
const orgShortFlag = new Set(["secret", "variable", "ruleset"]);

function parseFlags(args: string[], valued: string[]) {
  const letters = shortValued(valued);
  const flags = new Map<string, string[]>();
  const operands: string[] = [];
  const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const long = arg.match(/^(--[^=]+)=(.*)$/s);
    if (long) add(long[1], long[2]);
    else if (/^-[A-Za-z].+/.test(arg) && letters.has(arg[1])) add(arg.slice(0, 2), arg.slice(2));
    else if (arg.startsWith("-") && arg.length > 1 && arg !== "--") {
      const value = valued.includes(arg) && !args[index + 1]?.startsWith("-") ? args[++index] : undefined;
      add(arg, value ?? "");
    } else if (arg !== "--") operands.push(arg);
  }
  return { flags, operands };
}

function parseGh(args: string[]): Gh {
  const [group = ""] = parseFlags(args, valuedFlags.any).operands;
  const { flags, operands } = parseFlags(args, valuedFlags[aliases[group] ?? group] ?? valuedFlags.any);
  const [first = "", second = "", ...rest] = operands;
  return { group: aliases[first] ?? first, action: aliases[second] ?? second, operands: rest, flags };
}

const values = (gh: Gh, ...names: string[]) => names.flatMap((name) => gh.flags.get(name) ?? []);
const isOn = (gh: Gh, ...names: string[]) => values(gh, ...names).some((value) => value.toLowerCase() !== "false");
const repoOwner = (value: string) => {
  const segments = value.replace(/^[a-z+]+:\/\//i, "").replace(/^git@[^:]+:/, "").split("/").filter(Boolean);
  return (segments.length >= 3 ? segments[1] : segments[0]) ?? "";
};
const endpointOf = (gh: Gh) => gh.action.replace(/^https?:\/\/[^/]+\/(?:api\/v3\/)?/i, "").replace(/^\//, "");

function apiFields(gh: Gh): Map<string, string> {
  const fields = values(gh, "-f", "--raw-field", "-F", "--field").map((field) => field.match(/^([^=]*)=(.*)$/s));
  return new Map(fields.filter((field) => field !== null).map(([, key, value]) => [key.toLowerCase(), value.toLowerCase()]));
}

function apiRisk(gh: Gh, person: string): string | undefined {
  const endpoint = endpointOf(gh);
  const fields = apiFields(gh);
  const input = gh.flags.has("--input");
  const method = (values(gh, "-X", "--method").at(-1) ?? (fields.size > 0 || input ? "POST" : "GET")).toUpperCase();
  if (method === "GET") return undefined;
  if (accountEndpoints.test(endpoint)) return keyReason(person);
  if (endpoint === "graphql") return [...fields.values()].some((value) => /visibility\s*:\s*\\?"?public\b/.test(value)) || fields.get("visibility") === "public" ? exposureReason(person) : undefined;
  const publishes = fields.get("private") === "false" || fields.get("visibility") === "public";
  const keepsPrivate = fields.get("private") === "true" || fields.get("visibility") === "private" || fields.get("visibility") === "internal";
  if (repositoryEndpoint.test(endpoint) && method === "DELETE") return exposureReason(person);
  if (repositoryCreation.test(endpoint) && method === "POST" && (input || !keepsPrivate)) return exposureReason(person);
  if (repositoryEndpoint.test(endpoint) && method === "PATCH" && (input || publishes)) return exposureReason(person);
  return undefined;
}

function exposure(gh: Gh, person: string): string | undefined {
  const { group, action } = gh;
  if ((group === "ssh-key" || group === "gpg-key") && (action === "add" || action === "delete")) return keyReason(person);
  if (group === "auth" && (action === "login" || action === "token" || action === "refresh")) return tokenReason(person);
  if (group === "auth" && action === "status" && isOn(gh, "--show-token", "-t")) return tokenReason(person);
  if (group === "extension" && (action === "install" || action === "upgrade")) return extensionReason(person);
  if (group === "repo" && action === "delete") return exposureReason(person);
  if (group === "repo" && action === "create" && isOn(gh, "--public")) return exposureReason(person);
  if (group === "repo" && action === "edit" && values(gh, "--visibility").some((value) => value.toLowerCase() === "public")) return exposureReason(person);
  if (group === "gist" && action === "create" && isOn(gh, "--public", "-p")) return exposureReason(person);
  if (group === "api") return apiRisk(gh, person);
  return undefined;
}

function owners(gh: Gh, repoVariable: string | undefined): string[] {
  const repos = values(gh, "-R", "--repo");
  const found = [...repos, ...(repos.length === 0 && repoVariable ? [repoVariable] : [])].map(repoOwner);
  found.push(...values(gh, "--org", "--owner", ...(orgShortFlag.has(gh.group) ? ["-o"] : [])));
  const operands = gh.group === "api" ? [] : [gh.action, ...gh.operands];
  for (const operand of operands) found.push(operand.match(githubUrl)?.[1] ?? "");
  const [target] = gh.operands;
  if (gh.group === "repo" && repoTargets.has(gh.action) && target?.includes("/") && !githubUrl.test(target)) found.push(repoOwner(target));
  if (gh.group === "repo" && gh.action === "list" && target) found.push(target);
  if (gh.group === "api") found.push(endpointOf(gh).match(ownerEndpoint)?.[1] ?? "");
  return found.filter((owner) => owner && !/^[{$:]/.test(owner));
}

/** Parses guards.owners, a list of GitHub owners separated by commas or spaces. No list means no owner rule. */
export function ownerList(value: unknown): Set<string> | null {
  const names = typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean).map((name) => name.toLowerCase()) : [];
  return names.length ? new Set(names) : null;
}

/** Refuses gh commands that sign in, show or widen the token, change account keys, run extensions, delete or publish
 * code, or name a repository whose owner is not allowed. `inheritedRepo` is the GH_REPO the agent's shell inherits. */
export function ghRisk(command: string, allowed: ReadonlySet<string> | null, person: string, inheritedRepo?: string): string | undefined {
  for (const { name, args, env } of commandsIn(command)) {
    if (name !== "gh") continue;
    const gh = parseGh(args);
    const risk = exposure(gh, person);
    if (risk) return risk;
    const outside = allowed && owners(gh, env.get("GH_REPO") ?? inheritedRepo).find((owner) => !allowed.has(owner.toLowerCase()));
    if (outside) return ownerReason(outside, person);
  }
  return undefined;
}
