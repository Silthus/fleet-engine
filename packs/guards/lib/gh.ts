import { commandsIn } from "./shell-words.ts";

const keyReason = (person: string) => `Fleet blocked this command: it changes the SSH or GPG keys on ${person}'s GitHub account, which gives lasting access. If you need it, stop and ask ${person}.`;
const tokenReason = (person: string) => "Fleet blocked this command: it signs in to GitHub, or prints or widens the GitHub token. "
  + `Use \`gh\` or \`gh auth git-credential\`, which use the token without showing it. If you need a new sign-in or scope, stop and ask ${person} to run it.`;
const extensionReason = (person: string) => "Fleet blocked this command: a gh extension is code from a GitHub repository that runs with the GitHub token. "
  + `For gh stack, ask ${person} to turn on the gh-stack workflow, which installs a pinned version with a checked digest. For any other extension, stop and ask ${person}.`;
const exposureReason = (person: string) => `Fleet blocked this command: it deletes a repository or makes code public. If you need it, stop and ask ${person}.`;
const ownerReason = (owner: string, person: string) => `Fleet blocked this command: \`${owner}\` is not one of the GitHub owners agents may use on this machine. `
  + `Use a repository of an allowed owner, or stop and ask ${person} to add \`${owner}\` to guards.owners.`;
const spellOutReason = (owner: string) => `Fleet blocked this command: the repository owner \`${owner}\` is not spelled out, so the owner check cannot read it. `
  + "A shell variable, substitution, or pattern can name any owner. Write the owner as plain text, such as `gh api repos/<owner>/<repo>/...` or `--repo <owner>/<repo>`.";

type Gh = { group: string; action: string; operands: string[]; flags: Map<string, string[]> };

const valuedFlags: Record<string, string> = {
  other: "-b --body -t --title -B --base -H --head -F --body-file -l --label -a --assignee -m --milestone -r --reviewer --json -q --jq --template -L --limit "
    + "-s --state -A --author -e --env --app -n --notes --notes-file --target -p --pattern -D --dir -O --output --search -S --branch -h --hostname --visibility -o --org --owner",
  "pr create": "-a --assignee -B --base -b --body -F --body-file -H --head -l --label -m --milestone -p --project -r --reviewer -T --template -t --title --recover",
  "pr merge": "-b --body -F --body-file -t --subject --match-head-commit -A --author-email",
  "pr review": "-b --body -F --body-file",
  "pr comment": "-b --body -F --body-file",
  "pr edit": "--add-assignee --add-label --add-project --add-reviewer --remove-assignee --remove-label --remove-project --remove-reviewer -B --base -b --body -F --body-file -m --milestone -t --title",
  "pr view": "--json -q --jq -t --template",
  "pr checks": "--json -q --jq -t --template -i --interval",
  "pr checkout": "-b --branch",
  "pr close": "-c --comment",
  "pr reopen": "-c --comment",
  "pr lock": "-r --reason",
  "pr diff": "--color",
  "pr list": "-A --author -a --assignee -B --base -H --head -l --label -L --limit -S --search -s --state --app --json -q --jq -t --template",
  "issue create": "-a --assignee -b --body -F --body-file -l --label -m --milestone -p --project -T --template -t --title --recover",
  "issue comment": "-b --body -F --body-file",
  "issue edit": "--add-assignee --add-label --add-project --remove-assignee --remove-label --remove-project -b --body -F --body-file -m --milestone -t --title",
  "issue view": "--json -q --jq -t --template",
  "issue close": "-c --comment -r --reason",
  "issue reopen": "-c --comment",
  "issue lock": "-r --reason",
  "issue develop": "-b --base -n --name --branch-repo",
  "issue list": "-A --author -a --assignee -l --label -L --limit -S --search -s --state --app --mention -m --milestone --json -q --jq -t --template",
  "repo create": "--org -d --description -h --homepage -t --team -p --template -g --gitignore -l --license -s --source -r --remote",
  "repo fork": "--org --remote-name --fork-name",
  "repo clone": "-u --upstream-remote-name",
  "repo view": "-b --branch --json -q --jq -t --template",
  "repo edit": "-d --description -h --homepage --visibility --add-topic --remove-topic --default-branch",
  "repo list": "-L --limit -l --language --topic --visibility --json -q --jq -t --template",
  "repo sync": "-b --branch -s --source",
  api: "-X --method -H --header -f --raw-field -F --field --input -q --jq -t --template --cache -p --preview --hostname",
  auth: "-h --hostname -p --git-protocol -s --scopes -r --remove-scopes -u --user",
  "gist create": "-d --desc -f --filename",
};
const repoFlags = "-R --repo";
const aliases: Record<string, string> = { new: "create", ls: "list", rm: "delete", ext: "extension", extensions: "extension" };
const accountEndpoints = /^(?:user\/(?:keys|ssh_signing_keys|gpg_keys)|authorizations)\b/;
const repositoryEndpoint = /^repos\/[^/]+\/[^/]+\/?$/;
const repositoryCreation = /^(?:user\/repos|orgs\/[^/]+\/repos|repos\/[^/]+\/[^/]+\/generate)\/?$/;
const githubUrl = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)/;
const repoTargets = new Set(["clone", "view", "fork", "edit", "delete", "sync", "archive", "unarchive", "create", "set-default"]);
const orgShortFlag = new Set(["secret", "variable", "ruleset"]);

function parseFlags(args: string[], table: string) {
  const valued = new Set(`${repoFlags} ${table}`.split(" "));
  const flags = new Map<string, string[]>();
  const operands: string[] = [];
  const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const long = arg.match(/^(--[^=]+)(?:=(.*))?$/s);
    if (arg === "--") {
      operands.push(...args.slice(index + 1));
      break;
    } else if (long) add(long[1], long[2] ?? (valued.has(long[1]) ? args[++index] ?? "" : ""));
    else if (/^-[^-]/.test(arg)) {
      for (let letter = 1; letter < arg.length; letter++) {
        const name = `-${arg[letter]}`;
        if (arg[letter + 1] === "=") add(name, arg.slice(letter + 2));
        else if (valued.has(name)) add(name, arg.slice(letter + 1) || (args[++index] ?? ""));
        else {
          add(name, "");
          continue;
        }
        break;
      }
    } else operands.push(arg);
  }
  return { flags, operands };
}

function parseGh(args: string[]): Gh {
  const [group = "", action = ""] = parseFlags(args, valuedFlags.other).operands.map((word) => aliases[word] ?? word);
  const table = valuedFlags[`${group} ${action}`] ?? valuedFlags[group] ?? valuedFlags.other;
  const { flags, operands } = parseFlags(args, table);
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

function apiFields(gh: Gh): [string, string][] {
  const fields = values(gh, "-f", "--raw-field", "-F", "--field").map((field) => field.match(/^([^=]*)=(.*)$/s));
  return fields.filter((field) => field !== null).map(([, key, value]) => [key.toLowerCase(), value.toLowerCase()]);
}

const fieldName = (key: string) => key.match(/([^[\]]*)\]?$/)?.[1] ?? key;
const readOnlyQuery = /^\s*(?:query\b|\{)/;

function publishesByGraphql(fields: [string, string][]): boolean {
  const query = fields.find(([key]) => key === "query")?.[1] ?? "";
  if (readOnlyQuery.test(query)) return false;
  return fields.some(([key, value]) => /visibility\s*:\s*\\?"?public\b/.test(value) || (fieldName(key) === "visibility" && value === "public"));
}

function apiRisk(gh: Gh, person: string): string | undefined {
  const endpoint = endpointOf(gh);
  const pairs = apiFields(gh);
  const fields = new Map(pairs);
  const input = gh.flags.has("--input");
  const method = (values(gh, "-X", "--method").at(-1) ?? (fields.size > 0 || input ? "POST" : "GET")).toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;
  if (accountEndpoints.test(endpoint)) return keyReason(person);
  if (endpoint === "graphql") return publishesByGraphql(pairs) ? exposureReason(person) : undefined;
  const publishes = fields.get("private") === "false" || fields.get("visibility") === "public";
  const markedPrivate = fields.get("private") === "true";
  const keepsPrivate = endpoint.startsWith("orgs/") ? markedPrivate || ["private", "internal"].includes(fields.get("visibility") ?? "") : markedPrivate;
  if (repositoryEndpoint.test(endpoint) && method === "DELETE") return exposureReason(person);
  if (repositoryCreation.test(endpoint) && method === "POST" && (input || publishes || !keepsPrivate)) return exposureReason(person);
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

const placeholders = new Set(["{owner}", ":owner"]);
const plainName = /^[A-Za-z0-9._-]+$/;
const plainOwner = /^[A-Za-z0-9-]+$/;

function endpointOwner(endpoint: string): string {
  const [first = "", owner = ""] = endpoint.replace(/\?[^/]*=.*$|#.*$/s, "").split("/").filter(Boolean);
  if (/^(?:repos|orgs)$/i.test(first)) return owner;
  return /[$`*?[]/.test(first) ? first : "";
}

function owners(gh: Gh, repoVariable: string | undefined): string[] {
  const repos = values(gh, "-R", "--repo");
  const found = [...repos, ...(repos.length === 0 && repoVariable ? [repoVariable] : [])].map(repoOwner);
  found.push(...values(gh, "--org", "--owner", ...(orgShortFlag.has(gh.group) ? ["-o"] : [])));
  const operands = gh.group === "api" ? [] : [gh.action, ...gh.operands];
  for (const operand of operands) found.push(operand.match(githubUrl)?.[1] ?? "");
  const [target] = gh.operands;
  if (gh.group === "repo" && repoTargets.has(gh.action) && target && !githubUrl.test(target) && (target.includes("/") || !plainName.test(target))) found.push(repoOwner(target));
  if (gh.group === "repo" && gh.action === "list" && target) found.push(target);
  if (gh.group === "repo" && gh.action === "sync") found.push(...values(gh, "-s", "--source").map(repoOwner));
  if (gh.group === "repo" && gh.action === "create") found.push(...values(gh, "-p", "--template").map(repoOwner));
  if (gh.group === "api") found.push(endpointOwner(endpointOf(gh)));
  return found.filter((owner) => owner && !placeholders.has(owner));
}

function ownerRisk(owner: string, allowed: ReadonlySet<string>, person: string): string | undefined {
  if (!plainOwner.test(owner)) return spellOutReason(owner);
  return allowed.has(owner.toLowerCase()) ? undefined : ownerReason(owner, person);
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
    const ghArgs = name === "gh" ? args : name === "xargs" && args.includes("gh") ? args.slice(args.indexOf("gh") + 1) : undefined;
    if (!ghArgs) continue;
    const gh = parseGh(ghArgs);
    if (gh.flags.has("--help")) continue;
    const risk = exposure(gh, person);
    if (risk) return risk;
    if (!allowed) continue;
    for (const owner of owners(gh, env.get("GH_REPO") ?? inheritedRepo)) {
      const outside = ownerRisk(owner, allowed, person);
      if (outside) return outside;
    }
  }
  return undefined;
}
