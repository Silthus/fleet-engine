import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { loadPacks } from "../src/pack/manifest.ts";
import { fakeMachine, fleetSetup, savedAnswers } from "../src/setup/testing.ts";
import { isolateGit, tempDirs } from "../src/testing/git.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());

const root = join(import.meta.dir, "..");
const guide = () => readFileSync(join(root, "SETUP.md"), "utf8");
const presets = () => JSON.parse(readFileSync(join(root, "presets.json"), "utf8")) as Array<{ id: string; packs: string[] }>;

function packRows() {
  return [...guide().matchAll(/^\| `([a-z-]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)].map((match) => ({ name: match[1]!, summary: match[2]!, note: match[4]! }));
}

async function fleetCommands() {
  let usage = "";
  await main(["help"], { home: "/nonexistent", engineRoot: root, platform: "darwin", print: (line) => (usage += `${line}\n`) });
  return new Set(["help", ...[...usage.matchAll(/^ {2}fleet ([a-z]+)/gm)].map((match) => match[1])]);
}

describe("the agent setup guide", () => {
  test("runs only fleet commands that exist", async () => {
    const known = await fleetCommands();
    const text = guide();
    const code = [...text.matchAll(/^```\w*\n([\s\S]*?)^```$/gm), ...text.replace(/^```[\s\S]*?^```$/gm, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
    const used = code.flatMap((span) => [...span.matchAll(/\bfleet ([a-z]+)\b/g)].map((match) => match[1]));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((command) => !known.has(command!))).toEqual([]);
  });

  test("its fleet setup command sets up each preset to the end without asking the person anything", async () => {
    const command = guide().match(/^fleet setup (.+)$/m);
    expect(command).not.toBeNull();
    for (const preset of presets()) {
      const home = temp.make("home-");
      const args = command![1]!.replace("<id>", preset.id).replace("<claude|codex|both>", "both").split(" ");
      const result = await fleetSetup(home, args, [], fakeMachine(home), undefined, 0, "darwin");
      expect({ code: result.code, prompts: result.prompts, packs: savedAnswers(home).packs }).toEqual({ code: 0, prompts: [], packs: preset.packs });
    }
  });

  test("offers every pack setup can turn on, in the words of its own summary", async () => {
    const rows = packRows();
    const packs = (await loadPacks(root)).map((pack) => pack.manifest).filter((manifest) => manifest.name !== "base");
    expect(rows.map((row) => row.name).sort()).toEqual(packs.map((manifest) => manifest.name).sort());
    expect(rows.filter((row) => row.summary !== packs.find((manifest) => manifest.name === row.name)?.summary)).toEqual([]);
  });

  test("gives each pack its own setup note that is in the repo, or says it needs none, and names every note the packs hold", () => {
    const rows = packRows();
    const notes = rows.filter((row) => row.note.startsWith("`")).map((row) => ({ name: row.name, path: row.note.slice(1, -1) }));
    expect(notes.length).toBeGreaterThan(0);
    expect(rows.filter((row) => !row.note.startsWith("`") && !["None", "Step 9"].includes(row.note))).toEqual([]);
    expect(notes.filter(({ name, path }) => path !== `packs/${name}/SETUP.md` || !existsSync(join(root, path)))).toEqual([]);
    const held = readdirSync(join(root, "packs")).filter((pack) => existsSync(join(root, "packs", pack, "SETUP.md")));
    expect(notes.map((note) => note.name).sort()).toEqual(held.sort());
  });

  test("gives every command in the guide and the pack notes the same PATH, with Bun's Homebrew folders on it", () => {
    const notes = readdirSync(join(root, "packs")).map((pack) => join(root, "packs", pack, "SETUP.md")).filter(existsSync);
    const paths = [guide(), ...notes.map((path) => readFileSync(path, "utf8"))].flatMap((text) => [...text.matchAll(/export PATH="([^"]+)"/g)].map((match) => match[1]));
    expect(paths.length).toBeGreaterThan(1);
    expect(new Set(paths)).toEqual(new Set(["$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"]));
  });

  test("fetches only files that are in the repo", () => {
    const paths = [...guide().matchAll(/https:\/\/raw\.githubusercontent\.com\/Silthus\/fleet-engine\/main\/(\S+?)[`)\s]/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });
});
