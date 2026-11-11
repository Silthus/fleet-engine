import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { repoUrl } from "./pack/sources.ts";
import type { ProfileFile } from "./pack/types.ts";

export type UpdateOptions = {
  home: string;
  engineDir: string;
  profileDir: string;
  engine: ProfileFile["engine"];
  print: (line: string) => void;
  runApply: () => Promise<number>;
};

type Version = { tag: string; parts: [number, number, number] };

export function noticePath(home: string) {
  return join(home, ".local", "state", "fleet", "update.json");
}

export async function readNotice(home: string): Promise<string | undefined> {
  const file = Bun.file(noticePath(home));
  if (!(await file.exists())) return undefined;
  const notice = (await file.json()) as { newMajor?: string };
  return notice.newMajor ? `Fleet ${notice.newMajor} is out. It is a new major version, so fleet update does not apply it. Read its changelog, then change the engine ref in your profile.` : undefined;
}

export async function update(options: UpdateOptions): Promise<number> {
  if (!(await ready(options))) return 1;
  const before = (await git(options.engineDir, "rev-parse", "HEAD")).out;
  const moved = options.engine.channel === "track" ? await trackMain(options) : await followRelease(options);
  if (!moved) return 1;
  const failed = await installPackages(options.engineDir);
  if (failed !== undefined) return await rollBack(options, before, failed), 1;
  const profileMoved = await pullProfile(options);
  const applied = await options.runApply();
  return applied === 0 && !profileMoved ? 1 : applied;
}

async function pullProfile(options: UpdateOptions) {
  const remotes = await git(options.profileDir, "remote");
  if (!remotes.ok || !remotes.out) return true;
  const pulled = await git(options.profileDir, "pull", "-q", "--ff-only");
  if (!pulled.ok) options.print(`fleet update: your profile did not fast-forward, so this machine applies its last version and the update counts as failed: ${pulled.err}`);
  return pulled.ok;
}

/** The engine checkout must be clean, and its origin must be the profile's engine repository. */
async function ready(options: UpdateOptions) {
  const status = await git(options.engineDir, "status", "--porcelain");
  if (!status.ok) return options.print(`fleet update: ${options.engineDir} is not an engine checkout: ${status.err}`), false;
  if (status.out) return options.print(`fleet update: ${options.engineDir} has local changes. Save them elsewhere and remove them, then run fleet update again.`), false;
  const wanted = repoUrl(options.engine.repo);
  const origin = await git(options.engineDir, "remote", "get-url", "origin");
  if (origin.ok && origin.out === wanted) return true;
  const changed = await git(options.engineDir, "remote", origin.ok ? "set-url" : "add", "origin", wanted);
  if (!changed.ok) return options.print(`fleet update: could not point the engine at ${wanted}: ${changed.err}`), false;
  options.print(`The engine now comes from ${options.engine.repo}.`);
  return true;
}

async function trackMain(options: UpdateOptions) {
  const fetched = await git(options.engineDir, "fetch", "-q", "--depth", "1", "origin", "main");
  if (!fetched.ok) return options.print(`fleet update: could not fetch the engine: ${fetched.err}`), false;
  const checkedOut = await git(options.engineDir, "checkout", "-q", "--detach", "FETCH_HEAD");
  if (!checkedOut.ok) return options.print(`fleet update: could not check out main: ${checkedOut.err}`), false;
  options.print(`Engine follows main at ${(await git(options.engineDir, "rev-parse", "--short", "HEAD")).out}.`);
  return true;
}

async function followRelease(options: UpdateOptions) {
  const fetched = await git(options.engineDir, "fetch", "-q", "--depth", "1", "--tags", "--force", "origin");
  if (!fetched.ok) return options.print(`fleet update: could not fetch the engine: ${fetched.err}`), false;
  const versions = (await git(options.engineDir, "tag", "--list", "v*")).out.split("\n").flatMap((tag) => parse(tag) ?? []);
  const pin = parse(options.engine.ref);
  if (!pin) return options.print(`fleet update: the release channel needs a version tag as the engine ref, not ${options.engine.ref}.`), false;
  const sameMajor = versions.filter((version) => version.parts[0] === pin.parts[0]).sort(compare);
  const target = sameMajor.at(-1) ?? pin;
  const newer = versions.filter((version) => version.parts[0] > pin.parts[0]).sort(compare).at(-1);
  await saveNotice(options.home, newer?.tag);
  if (newer) options.print(`Fleet ${newer.tag} is out. It is a new major version, so this update stays on v${pin.parts[0]}.`);
  const installed = (await git(options.engineDir, "tag", "--points-at", "HEAD")).out.split("\n").flatMap((tag) => parse(tag) ?? []).sort(compare).at(-1);
  if (!installed) {
    const head = (await git(options.engineDir, "rev-parse", "--short", "HEAD")).out;
    options.print(`Engine stays at ${head}, which is not a release, so fleet update does not move it back. Set engine.channel to track to follow main, or run get.sh --ref ${target.tag}.`);
    return true;
  }
  if (compare(installed, target) >= 0) return options.print(`Engine is at ${installed.tag}.`), true;
  const checkedOut = await git(options.engineDir, "checkout", "-q", "--detach", `refs/tags/${target.tag}`);
  if (!checkedOut.ok) return options.print(`fleet update: could not check out ${target.tag}: ${checkedOut.err}`), false;
  options.print(`Engine is at ${target.tag}.`);
  return true;
}

async function installPackages(engineDir: string) {
  const child = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--production"], { cwd: engineDir, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 300_000 });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return code === 0 ? undefined : (err || out).trim();
}

async function rollBack(options: UpdateOptions, before: string, installError: string) {
  const failed = `fleet update: could not install the engine's packages in ${options.engineDir}`;
  const restored = await git(options.engineDir, "checkout", "-q", "--force", "--detach", before);
  if (!restored.ok) return options.print(`${failed}, and could not roll the engine back to ${before.slice(0, 7)}: ${restored.err}. Run get.sh again to repair it.\n${installError}`);
  const repair = (await installPackages(options.engineDir)) === undefined ? "" : " Its packages did not install either, so run get.sh again to repair it.";
  options.print(`${failed}, so the update was rolled back. The engine stays at ${before.slice(0, 7)}.${repair}\n${installError}`);
}

async function saveNotice(home: string, newMajor: string | undefined) {
  const path = noticePath(home);
  if (!newMajor) return rm(path, { force: true });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ newMajor }) + "\n");
}

function parse(tag: string): Version | undefined {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  return match ? { tag: tag.trim(), parts: [Number(match[1]), Number(match[2]), Number(match[3])] } : undefined;
}

function compare(a: Version, b: Version) {
  return a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2];
}

async function git(dir: string, ...args: string[]) {
  const env = { ...Bun.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
  const child = Bun.spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, timeout: 120_000 });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ok: code === 0, out: out.trim(), err: err.trim().split("\n").at(-1) ?? "" };
}
