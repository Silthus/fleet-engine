import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withDirectories } from "./directories.ts";
import { shortCluster } from "./kill.ts";
import { commandsIn } from "./shell-words.ts";

export type Repo = { config: (key: string) => string | undefined; values: (key: string) => string[]; branch?: string; branches: string[]; agents?: string };
export type ReadRepo = (dir: string, selectors: string[]) => Repo | undefined;

export const largestForcePush = 5;
const mainBranches = new Set(["main", "master"]);
const commitValuedLetters = "mFCctSu";
const commitValued = new Set(["-m", "-F", "-C", "-c", "-t", "--message", "--file", "--author", "--date", "--template", "--reuse-message", "--reedit-message", "--fixup", "--squash", "--trailer", "--cleanup"]);
const pushValued = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

const hooksReason = (person: string) => "Fleet blocked this command: it skips the Git hooks, which run the repository's checks. "
  + `Let them run: fix what they report, then commit or push with hooks on. If a hook is broken, stop and ask ${person}.`;

const mainReason = (target: string, slug: string, upstream: boolean, person: string) => `Fleet blocked this command: it pushes to \`${target}\` of ${slug}`
  + (upstream ? `, because the branch tracks \`${target}\` and push.default is upstream,` : "")
  + " and that repository takes changes through pull requests. Push to your own branch: `git push -u origin HEAD:refs/heads/<branch>`. "
  + `If this repository takes pushes to ${target}, stop and ask ${person} to add ${slug} to guards.main-push-repos.`;

const forceReason = (person: string) => "Fleet blocked this command: it force-pushes without a lease, which can drop commits someone else pushed. "
  + "Use `git push --force-with-lease=<branch>:<expected sha> origin <branch>`, without a `+` on the refspec. "
  + `If you need to overwrite the branch anyway, stop and ask ${person}.`;

const burstReason = (count: number, person: string) => `Fleet blocked this command: it force-pushes ${count} branches at once, `
  + "and bursts like that make GitHub fail many CI runs at startup. "
  + `Push in batches of at most ${largestForcePush} branches, about a minute apart. If that does not fit, stop and ask ${person}.`;

export const githubSlug = (url: string) => url.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)?.slice(1, 3).join("/");

/** An AGENTS.md line such as "Commit and push directly to `main`", without a "never" or "not". */
export const agentsPushToMain = (text = "") => text.split("\n").some((line) =>
  /\b(?:commit|push)\w*\b.*\b(?:directly|straight)\s+to\s+`?(?:main|master)\b/i.test(line) && !/\b(?:never|not|don't|do not|avoid)\b/i.test(line));

const configKey = (key: string) => {
  const parts = key.split(".");
  return parts.length < 3 ? key.toLowerCase() : [parts[0].toLowerCase(), ...parts.slice(1, -1), parts.at(-1)!.toLowerCase()].join(".");
};

function insideWorkTree(dir: string): boolean {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return true;
    if (dirname(current) === current) return false;
  }
}

const selectsRepository = (selectors: string[]) => selectors.some((selector) => /^--(?:git-dir|work-tree)/.test(selector));

export const readRepo: ReadRepo = (dir, selectors) => {
  if (!existsSync(dir) || (!selectsRepository(selectors) && !insideWorkTree(dir))) return undefined;
  const git = (args: string[], required = true) => {
    const result = Bun.spawnSync(["git", ...selectors, ...args], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    if (result.exitCode === 0) return result.stdout.toString();
    if (required || result.exitCode === null) throw new Error(`\`git ${args.join(" ")}\` failed in ${dir}`);
    return undefined;
  };
  if (git(["rev-parse", "--git-dir"], false) === undefined) return undefined;
  const top = git(["rev-parse", "--show-toplevel"], false)?.trim();
  const values = new Map<string, string[]>();
  for (const entry of git(["config", "--list", "-z"])!.split("\0").filter(Boolean)) {
    const split = entry.indexOf("\n");
    const key = configKey(split < 0 ? entry : entry.slice(0, split));
    values.set(key, [...values.get(key) ?? [], split < 0 ? "true" : entry.slice(split + 1)]);
  }
  const agents = top && join(top, "AGENTS.md");
  return {
    values: (key) => values.get(configKey(key)) ?? [],
    config: (key) => values.get(configKey(key))?.at(-1),
    branch: git(["symbolic-ref", "-q", "--short", "HEAD"], false)?.trim() || undefined,
    branches: git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])!.split("\n").filter(Boolean),
    agents: agents && existsSync(agents) ? readFileSync(agents, "utf8") : undefined,
  };
};

type GitCall = { dir: string | undefined; selectors: string[]; settings: string[]; sub?: string; args: string[] };

function gitCall(args: string[], cwd: string | undefined): GitCall {
  let dir = cwd;
  const selectors: string[] = [];
  const settings: string[] = [];
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-C") dir = dir === undefined ? undefined : resolve(dir, args[++index] ?? ".");
    else if (arg === "-c" || arg === "--config-env") settings.push(args[++index] ?? "");
    else if (/^-c./.test(arg)) settings.push(arg.slice(2));
    else if (arg.startsWith("--config-env=")) settings.push(arg.slice("--config-env=".length));
    else if (arg === "--git-dir" || arg === "--work-tree") selectors.push(`${arg}=${args[++index] ?? ""}`);
    else if (/^--(?:git-dir|work-tree)=/.test(arg)) selectors.push(arg);
    else if (arg === "--namespace") index++;
    else if (!arg.startsWith("-")) break;
  }
  return { dir, selectors, settings, sub: args[index], args: args.slice(index + 1) };
}

function withSettings(repo: Repo, settings: string[]): Repo {
  const given = new Map<string, string>();
  for (const setting of settings) {
    const split = setting.indexOf("=");
    given.set(configKey(split < 0 ? setting : setting.slice(0, split)), split < 0 ? "true" : setting.slice(split + 1));
  }
  return { ...repo, config: (key) => given.get(configKey(key)) ?? repo.config(key), values: (key) => given.has(configKey(key)) ? [given.get(configKey(key))!] : repo.values(key) };
}

function skipsCommitHooks(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return false;
    if (commitValued.has(arg)) index++;
    else if (arg === "--no-verify" || shortCluster(arg, "n", commitValuedLetters)) return true;
    else if (/^-[A-Za-z]+$/.test(arg) && commitValuedLetters.includes(arg.at(-1)!) && !shortCluster(arg, "n", "")) index++;
  }
  return false;
}

type Push = { remote?: string; refspecs: string[]; force: boolean; lease: boolean; all: boolean; deletes: boolean; noVerify: boolean; dryRun: boolean };

function parsePush(args: string[]): Push {
  const push: Push = { refspecs: [], force: false, lease: false, all: false, deletes: false, noVerify: false, dryRun: false };
  const operands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (pushValued.has(arg)) {
      if (arg === "--repo") push.remote = args[index + 1];
      index++;
    } else if (arg.startsWith("--repo=")) push.remote = arg.slice(7);
    else if (arg === "--no-verify") push.noVerify = true;
    else if (arg === "--dry-run" || shortCluster(arg, "n", "o")) push.dryRun = true;
    else if (arg.startsWith("--force-with-lease")) push.lease = true;
    else if (arg === "--force" || shortCluster(arg, "f", "o")) push.force = true;
    else if (arg === "--mirror") push.force = push.all = true;
    else if (arg === "--all" || arg === "--branches") push.all = true;
    else if (arg === "--delete" || shortCluster(arg, "d", "o")) push.deletes = true;
    else if (!arg.startsWith("-")) operands.push(arg);
  }
  push.remote = operands[0] ?? push.remote;
  push.refspecs = operands.slice(1);
  return push;
}

const branchName = (ref: string) => ref.replace(/^refs\/heads\//, "");

type Target = { name: string; upstream: boolean };

function remoteOf(push: Push, repo: Repo): { name?: string; urls: string[] } {
  const branch = repo.branch;
  const name = push.remote ?? (branch && repo.config(`branch.${branch}.pushRemote`)) ?? repo.config("remote.pushDefault") ?? (branch && repo.config(`branch.${branch}.remote`)) ?? "origin";
  if (/[:/]/.test(name)) return { urls: [name] };
  const pushUrls = repo.values(`remote.${name}.pushurl`);
  return { name, urls: pushUrls.length > 0 ? pushUrls : repo.values(`remote.${name}.url`) };
}

const globPattern = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", "(.*)")}$`);

function expandWildcard(spec: string, branches: string[]): Target[] {
  const [source, destination = source] = spec.split(":");
  const pattern = globPattern(source.startsWith("refs/") ? source : `refs/heads/${source}`);
  return branches.flatMap((branch) => {
    const match = `refs/heads/${branch}`.match(pattern);
    return match ? [{ name: branchName(destination.replace("*", match[1])), upstream: false }] : [];
  });
}

const configuredSpecs = (push: Push, repo: Repo, remote: string | undefined) =>
  push.refspecs.length > 0 ? push.refspecs : remote ? repo.values(`remote.${remote}.push`) : [];

const mirrors = (repo: Repo, remote: string | undefined) => remote !== undefined && repo.config(`remote.${remote}.mirror`) === "true";

/** Where each ref of a push lands, as Git resolves it, including a bare `git push` under push.default. */
function targets(push: Push, repo: Repo, remote: string | undefined): Target[] {
  const pushDefault = repo.config("push.default") ?? "simple";
  const upstreamOf = (branch: string) => repo.config(`branch.${branch}.remote`) === remote ? repo.config(`branch.${branch}.merge`) : undefined;
  const every = () => repo.branches.map((name) => ({ name, upstream: false }));
  if (push.all || mirrors(repo, remote)) return every();
  const resolveSpec = (spec: string): Target[] => {
    const bare = spec.replace(/^\+/, "");
    if (bare === ":") return every();
    if (bare.includes("*")) return expandWildcard(bare, repo.branches);
    if (bare.includes(":")) return [{ name: branchName(bare.slice(bare.indexOf(":") + 1)), upstream: false }];
    if (bare === "HEAD" || bare === "@") return repo.branch ? [{ name: repo.branch, upstream: false }] : [];
    const local = branchName(bare);
    const upstream = !push.deletes && repo.branches.includes(local) && pushDefault === "upstream" ? upstreamOf(local) : undefined;
    return [{ name: branchName(upstream ?? local), upstream: upstream !== undefined }];
  };
  const specs = configuredSpecs(push, repo, remote);
  if (specs.length > 0) return specs.flatMap(resolveSpec);
  const branch = repo.branch;
  if (!branch || pushDefault === "nothing") return [];
  if (pushDefault === "matching") return every();
  const upstream = upstreamOf(branch);
  if (pushDefault === "upstream" || pushDefault === "tracking") return upstream ? [{ name: branchName(upstream), upstream: true }] : [];
  if (pushDefault === "simple" && upstream && branchName(upstream) !== branch) return [];
  return [{ name: branch, upstream: false }];
}

const forcesWithoutLease = (push: Push, repo: Repo, remote: string | undefined) =>
  mirrors(repo, remote) || configuredSpecs(push, repo, remote).some((spec) => spec.startsWith("+"));

/** Refuses Git calls that skip hooks, pushes to main or master of a GitHub repository that takes pull requests, force pushes
 * without a lease, and leased force pushes of more than five branches at once. A dry run passes. */
export function gitRisk(command: string, cwd: string, person: string, mainPushRepos: ReadonlySet<string>, read: ReadRepo = readRepo): string | undefined {
  const repos = new Map<string, Repo | undefined>();
  const repoAt = (dir: string | undefined, selectors: string[]) => {
    if (dir === undefined) return undefined;
    const key = [dir, ...selectors].join("\0");
    if (!repos.has(key)) repos.set(key, read(dir, selectors));
    return repos.get(key);
  };
  let forced = 0;
  for (const [call, directory] of withDirectories(commandsIn(command), cwd)) {
    if (call.name !== "git") continue;
    const { dir, selectors, settings, sub, args } = gitCall(call.args, directory);
    if (sub !== "commit" && sub !== "push" && sub !== "merge") continue;
    if (settings.some((setting) => /^core\.hookspath=/i.test(setting))) return hooksReason(person);
    if (sub === "commit" && skipsCommitHooks(args)) return hooksReason(person);
    if (sub === "merge" && args.includes("--no-verify")) return hooksReason(person);
    if (sub !== "push") continue;
    const push = parsePush(args);
    if (push.dryRun) continue;
    if (push.noVerify) return hooksReason(person);
    if (push.force || push.refspecs.some((spec) => spec.startsWith("+"))) return forceReason(person);
    const found = repoAt(dir, selectors);
    if (!found) {
      if (push.lease) forced += push.all ? largestForcePush + 1 : Math.max(1, push.refspecs.length);
      continue;
    }
    const repo = withSettings(found, settings);
    const remote = remoteOf(push, repo);
    if (forcesWithoutLease(push, repo, remote.name)) return forceReason(person);
    const landing = targets(push, repo, remote.name);
    if (push.lease) forced += landing.length;
    const slugs = remote.urls.map(githubSlug).filter((slug): slug is string => slug !== undefined);
    const guarded = slugs.find((slug) => !mainPushRepos.has(slug.toLowerCase()));
    if (!guarded || agentsPushToMain(repo.agents)) continue;
    const main = landing.find((target) => mainBranches.has(target.name));
    if (main) return mainReason(main.name, guarded, main.upstream, person);
  }
  return forced > largestForcePush ? burstReason(forced, person) : undefined;
}

export const repoList = (value: unknown) => new Set(typeof value === "string" ? value.split(/[\s,]+/).map((repo) => repo.trim().toLowerCase()).filter(Boolean) : []);
