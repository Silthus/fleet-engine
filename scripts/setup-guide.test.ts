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
const notePaths = () => readdirSync(join(root, "packs")).map((pack) => join("packs", pack, "SETUP.md")).filter((path) => existsSync(join(root, path)));

function codeIn(text: string) {
  const blocks = [...text.matchAll(/^ *```\w*\n([\s\S]*?)^ *```$/gm)].map((match) => match[1]!.replace(/^ +/gm, ""));
  const spans = [...text.replace(/^ *```[\s\S]*?^ *```$/gm, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  return [...blocks, ...spans];
}
const manifests = async () => (await loadPacks(root)).map((pack) => pack.manifest);
const hubStep = () => guide().slice(guide().indexOf("## 9. Add the hub and the node"));
const words = (text: string) => text.replace(/\s+/g, " ");

function flagValues(flag: string) {
  const code = [guide(), ...notePaths().map((path) => readFileSync(join(root, path), "utf8"))].flatMap(codeIn).join("\n");
  return [...code.matchAll(new RegExp(`${flag} (\\S+)`, "g"))].map((match) => match[1]!).filter((value) => !value.startsWith("<"));
}

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
    const code = [guide(), ...notePaths().map((path) => readFileSync(join(root, path), "utf8"))].flatMap(codeIn);
    const used = code.flatMap((span) => [...span.matchAll(/\bfleet ([a-z]+)\b/g)].map((match) => match[1]));
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((command) => !known.has(command!))).toEqual([]);
  });

  test("turns workflows on or off only by ids that exist", async () => {
    const workflows = new Set((await manifests()).flatMap((manifest) => (manifest.workflows ?? []).map((workflow) => workflow.id)));
    const pairs = flagValues("--workflows").flatMap((value) => value.split(","));
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.filter((pair) => !/^[a-z-]+=(on|off)$/.test(pair) || !workflows.has(pair.split("=")[0]!))).toEqual([]);
  });

  test("sets only settings that exist", async () => {
    const settings = new Set((await manifests()).flatMap((manifest) => (manifest.settings ?? []).map((setting) => setting.key)));
    const keys = flagValues("--set").map((value) => value.split("=")[0]!);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !settings.has(key))).toEqual([]);
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
    expect(rows.filter((row) => !row.note.startsWith("`") && row.note !== "None")).toEqual([]);
    expect(notes.filter(({ name, path }) => path !== `packs/${name}/SETUP.md` || !existsSync(join(root, path)))).toEqual([]);
    const held = readdirSync(join(root, "packs")).filter((pack) => existsSync(join(root, "packs", pack, "SETUP.md")));
    expect(notes.map((note) => note.name).sort()).toEqual(held.sort());
  });

  test("with a hub and a node, creates a 200 GB hub and a 500 GB node with every parameter given, so Coder asks nothing", () => {
    expect(words(hubStep())).toContain("The default is one **hub** with a 200 GB disk and one **node** with a 500 GB disk");
    expect(codeIn(hubStep()).find((code) => code.startsWith("coder create "))).toBe("coder create <name> --template <template> --parameter <disk parameter>=<200 or 500> --yes\n");
  });

  test("with a hub and a node, keeps both running while the Mac sleeps", () => {
    expect(codeIn(hubStep())).toContain("coder schedule stop <name> manual");
  });

  test("with a hub and a node, says how to add a node later", () => {
    expect(words(hubStep())).toContain("To add a node later, when the load grows, run steps 3 to 6 again with a new name and a 500 GB disk");
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
