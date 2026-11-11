import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { loadPacks } from "../src/pack/manifest.ts";
import { parseSetupFlags } from "../src/setup/flags.ts";

const root = join(import.meta.dir, "..");
const guide = () => readFileSync(join(root, "SETUP.md"), "utf8");
const notePaths = () => readdirSync(join(root, "packs")).map((pack) => join("packs", pack, "SETUP.md")).filter((path) => existsSync(join(root, path)));

function codeIn(text: string) {
  const blocks = [...text.matchAll(/^ *```\w*\n([\s\S]*?)^ *```$/gm)].map((match) => match[1]!.replace(/^ +/gm, ""));
  const spans = [...text.replace(/^ *```[\s\S]*?^ *```$/gm, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  return [...blocks, ...spans];
}
const presets = () => (JSON.parse(readFileSync(join(root, "presets.json"), "utf8")) as Array<{ id: string }>).map((preset) => preset.id);

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

  test("turns on only packs, workflows and settings that exist, in the guide and in every pack note", async () => {
    const packs = (await loadPacks(root)).map((pack) => pack.manifest);
    const workflows = new Set(packs.flatMap((manifest) => (manifest.workflows ?? []).map((workflow) => workflow.id)));
    const settings = new Set(packs.flatMap((manifest) => (manifest.settings ?? []).map((setting) => setting.key)));
    const code = [guide(), ...notePaths().map((path) => readFileSync(join(root, path), "utf8"))].flatMap(codeIn).join("\n");
    const named = (flag: string) => [...code.matchAll(new RegExp(`${flag} ([a-z][\\w.-]*)`, "g"))].map((match) => match[1]!);
    expect(named("--add").length + named("--workflows").length + named("--set").length).toBeGreaterThan(0);
    expect(named("--add").filter((name) => !packs.some((manifest) => manifest.name === name))).toEqual([]);
    expect(named("--workflows").filter((id) => !workflows.has(id))).toEqual([]);
    expect(named("--set").filter((key) => !settings.has(key))).toEqual([]);
  });

  test("drives fleet setup with flags that fleet setup takes, without asking the person anything", () => {
    const command = guide().match(/^fleet setup (.+)$/m);
    expect(command).not.toBeNull();
    for (const preset of presets()) {
      const args = command![1]!.replace("<id>", preset).replace("<claude|codex|both>", "both").split(" ");
      expect(parseSetupFlags(args)).toMatchObject({ preset, plan: "both", devbox: "skip", nonInteractive: true });
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

  test("with a hub and a node, creates one 200 GB hub and one 500 GB node without a Coder question, keeps them running, and says how to add a node", () => {
    const step = guide().slice(guide().indexOf("## 9. Add the hub and the node"));
    const create = codeIn(step).find((code) => code.startsWith("coder create "));
    expect(create).toBe("coder create <name> --template <template> --parameter <disk parameter>=<200 or 500> --yes\n");
    expect(step).toContain("one **hub** with a 200 GB disk and one **node** with a 500 GB\ndisk");
    expect(codeIn(step)).toContain("coder schedule stop <name> manual");
    expect(step).toMatch(/To add a node later, when the load grows, run steps 3 to 6 again with a new\nname and a 500 GB disk/);
  });

  test("fetches only files that are in the repo", () => {
    const paths = [...guide().matchAll(/https:\/\/raw\.githubusercontent\.com\/Silthus\/fleet-engine\/main\/(\S+?)[`)\s]/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });
});
