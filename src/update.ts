import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  const moved = options.engine.channel === "track" ? await trackMain(options) : await followRelease(options);
  if (!moved) return 1;
  const profile = await git(options.profileDir, "remote");
  if (profile.ok && profile.out) {
    const pulled = await git(options.profileDir, "pull", "-q", "--ff-only");
    if (!pulled.ok) options.print(`Note: your profile did not fast-forward, so this machine uses its last version: ${pulled.err}`);
  }
  return options.runApply();
}

async function trackMain(options: UpdateOptions) {
  const fetched = await git(options.engineDir, "fetch", "-q", "--depth", "1", "origin", "main");
  if (!fetched.ok) return options.print(`fleet update: could not fetch the engine: ${fetched.err}`), false;
  await git(options.engineDir, "checkout", "-q", "--force", "--detach", "FETCH_HEAD");
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
  const checkedOut = await git(options.engineDir, "checkout", "-q", "--force", "--detach", `refs/tags/${target.tag}`);
  if (!checkedOut.ok) return options.print(`fleet update: could not check out ${target.tag}: ${checkedOut.err}`), false;
  options.print(`Engine is at ${target.tag}.`);
  return true;
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
  const child = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" } });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { ok: code === 0, out: out.trim(), err: err.trim().split("\n").at(-1) ?? "" };
}
