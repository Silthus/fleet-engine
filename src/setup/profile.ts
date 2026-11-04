import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackManifest, ProfileFile } from "../pack/types.ts";
import { saveAnswers } from "../profile/profile.ts";
import type { Machine } from "./commands.ts";
import { defaultSources, engineRepo } from "./defaults.ts";
import type { Draft } from "./questions.ts";
import type { Step } from "./runner.ts";
import { Stopped, type Terminal } from "./terminal.ts";

export const profileRepoName = "fleet-profile";
export const memoryRepoName = "fleet-memory";
export const profilePath = (home: string) => join(home, ".local", "share", "fleet", "profile");

export type ProfileContext = {
  terminal: Terminal;
  machine: Machine;
  home: string;
  engineRoot: string;
  nonInteractive: boolean;
  draft: Draft;
  packs: PackManifest[];
  /** Called once fleet.json holds every answer and is pushed: the draft is no longer needed. */
  saved(dir: string): Promise<void>;
};

export function profileStep(context: ProfileContext): Step {
  return { id: "profile", title: "Make your profile", minutes: 1, kind: "auto", run: () => makeProfile(context) };
}

async function makeProfile(context: ProfileContext) {
  const { terminal, machine, home, draft } = context;
  const gh = async (...args: string[]) => {
    const result = await machine.exec(["gh", ...args]);
    if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${lastLine(result.output)}`);
    return result.output.trim();
  };
  const login = await gh("api", "user", "--jq", ".login");
  const profileRepo = `${login}/${profileRepoName}`;
  const memoryRepo = draft.packs?.includes("memory") && draft.settings?.["memory.repo"] === undefined ? `${login}/${memoryRepoName}` : undefined;
  const exists = async (repo: string) => (await machine.exec(["gh", "repo", "view", repo, "--json", "name"])).code === 0;
  const missing = [];
  for (const repo of [profileRepo, memoryRepo]) if (repo && !(await exists(repo))) missing.push(repo);
  await confirm(context, missing);
  for (const repo of missing) {
    await gh("repo", "create", repo, "--private", "--description", repo === profileRepo ? "My Fleet profile" : "My agents' shared memory");
    terminal.print(`  ✓ Created the private repo ${repo}`);
  }
  for (const repo of [profileRepo, memoryRepo]) if (repo && !missing.includes(repo)) terminal.print(`  ✓ Reusing your repo ${repo}`);
  await gh("auth", "setup-git");

  const dir = profilePath(home);
  await checkout(machine, dir, profileRepo);
  await git(machine, dir, "config", "user.name", login);
  await git(machine, dir, "config", "user.email", `${login}@users.noreply.github.com`);
  const started = await startFiles(dir, context);
  const answers: Partial<ProfileFile> = {
    ...(existsSync(join(dir, "fleet.json")) ? {} : { schema: 1, engine: await enginePin(context), sources: defaultSources, settings: {}, workflows: {} }),
    ...draft,
    ...(memoryRepo ? { settings: { ...draft.settings, "memory.repo": memoryRepo } } : {}),
  };
  if (started.length) {
    await git(machine, dir, "add", "--", ...started);
    await git(machine, dir, "commit", "-q", "-m", "Start my Fleet profile", "--", ...started);
  }
  await saveAnswers(dir, answers);
  await git(machine, dir, "branch", "-M", "main");
  await git(machine, dir, "push", "-q", "-u", "origin", "main");
  terminal.print(`  ✓ Saved your answers in ${profileRepo}. Every machine of yours reads it.`);
  await context.saved(dir);
}

async function confirm({ terminal, nonInteractive }: ProfileContext, missing: string[]) {
  if (!missing.length || nonInteractive) return;
  terminal.print(`  Fleet creates ${missing.length === 1 ? "the private repo" : "the private repos"} ${missing.join(" and ")} in your GitHub account and pushes your answers there.`);
  for (;;) {
    const reply = (await terminal.ask("  Go ahead? (Y/n) ")).toLowerCase();
    if (reply === "" || reply === "y" || reply === "yes") return;
    if (reply === "n" || reply === "no") {
      terminal.print("  Nothing was created.");
      throw new Stopped();
    }
  }
}

async function checkout(machine: Machine, dir: string, repo: string) {
  if (existsSync(join(dir, ".git"))) {
    const origin = (await machine.exec(["git", "-C", dir, "remote", "get-url", "origin"])).output.trim();
    if (!origin.includes(`github.com/${repo}`) && !origin.includes(`github.com:${repo}`)) throw new Error(`${dir} is a clone of ${origin}, not ${repo}. Move it away, then run fleet setup again.`);
    await git(machine, dir, "fetch", "-q", "origin");
    const remote = await machine.exec(["git", "-C", dir, "rev-parse", "--verify", "-q", "origin/main"]);
    if (remote.code === 0) await git(machine, dir, "merge", "-q", "--ff-only", "origin/main");
    return;
  }
  if (existsSync(dir)) throw new Error(`${dir} exists and is not your profile. Move it away, then run fleet setup again.`);
  await mkdir(join(dir, ".."), { recursive: true });
  const cloned = await machine.exec(["git", "clone", "-q", `https://github.com/${repo}.git`, dir]);
  if (cloned.code !== 0) throw new Error(`could not clone ${repo}: ${lastLine(cloned.output)}`);
}

/** Writes the shim, "about me", and the guide when the profile lacks them, and returns what it wrote. */
async function startFiles(dir: string, context: ProfileContext) {
  const written: string[] = [];
  const write = async (name: string, make: (path: string) => Promise<void>) => {
    const path = join(dir, name);
    if (existsSync(path)) return;
    await make(path);
    written.push(name);
  };
  await write("install.sh", (path) => copyFile(join(context.engineRoot, "templates/profile/install.sh"), path));
  await write("about-me.md", (path) => writeFile(path, "# About me\n\nWrite how you like to work here. Agents read it after your packs' rules.\n"));
  await write("README.md", (path) => writeFile(path, profileGuide(context.packs)));
  return written;
}

/** The engine ref this profile pins: the release tag the engine runs on, or main on the track channel. */
async function enginePin({ machine, engineRoot }: ProfileContext): Promise<ProfileFile["engine"]> {
  const tag = await machine.exec(["git", "-C", engineRoot, "describe", "--tags", "--exact-match", "--match", "v[0-9]*"]);
  const ref = tag.output.trim();
  return tag.code === 0 && /^v\d+\.\d+\.\d+$/.test(ref) ? { repo: engineRepo, ref, channel: "release" } : { repo: engineRepo, ref: "main", channel: "track" };
}

async function git(machine: Machine, dir: string, ...args: string[]) {
  const result = await machine.exec(["git", "-C", dir, ...args]);
  if (result.code !== 0) throw new Error(`git ${args[0]} in ${dir} failed: ${lastLine(result.output)}`);
}

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

export function profileGuide(packs: PackManifest[]) {
  const sections = packs
    .filter((pack) => pack.settings?.length)
    .map((pack) => {
      const rows = pack.settings!.map((setting) => `| \`${setting.key}\` | ${setting.question} | ${setting.default === undefined ? (setting.optional ? "not set" : "asked") : `\`${String(setting.default)}\``} |`);
      return [`### ${pack.name}`, "", "| Setting | What it is | Default |", "| --- | --- | --- |", ...rows].join("\n");
    });
  return [
    "# My Fleet profile",
    "",
    "Fleet reads this repo on every machine of mine. Fleet's commands change it for me, so I rarely edit it by hand.",
    "",
    "- `fleet.json`: my packs, my AI plans, my settings, and the workflows I turned on or off.",
    "- `about-me.md`: how I like to work. Agents read it after my packs' rules.",
    "- `install.sh`: installs Fleet from this profile. A Coder devbox runs it as my dotfiles.",
    "",
    "## Changing things",
    "",
    "- `fleet packs --add <pack>` or `--remove <pack>` turns a pack on or off.",
    "- `fleet settings` lists my settings, and `fleet set <pack.key>=<value>` changes one.",
    "",
    "Each change applies on this machine at once. My other machines pick it up at their next daily `fleet update`.",
    "",
    "## Settings",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}
