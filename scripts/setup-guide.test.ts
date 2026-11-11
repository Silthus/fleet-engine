import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { loadPacks } from "../src/pack/manifest.ts";
import { cachedSource } from "../src/pack/sources.ts";
import { sourceCache } from "../src/setup/setup.ts";
import { fakeMachine, fleetSetup, savedAnswers } from "../src/setup/testing.ts";
import { isolateGit, tempDirs } from "../src/testing/git.ts";
import { needsHubPacks, prefersHubPacks } from "../src/setup/defaults.ts";
import { presetPicks, promptLabels, promptText, setSetting, toggleWorkflow } from "../page/model.ts";
import { pageData } from "./build-page.ts";

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
const guidePath = "$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";
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
  const commandFiles = (dir: string) => (existsSync(join(dir, "commands")) ? readdirSync(join(dir, "commands")).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => name.slice(0, -3)) : []);
  const shipped = (await loadPacks(root)).flatMap(({ dir, code }) => [...Object.keys(code?.commands ?? {}), ...commandFiles(dir)]);
  return new Set(["help", ...shipped, ...[...usage.matchAll(/^ {2}fleet ([a-z][a-z-]*)/gm)].map((match) => match[1])]);
}

describe("the agent setup guide", () => {
  test("runs only fleet commands that exist", async () => {
    const known = await fleetCommands();
    const code = [guide(), ...notePaths().map((path) => readFileSync(join(root, path), "utf8"))].flatMap(codeIn);
    const used = code.flatMap((span) => [...span.matchAll(/\bfleet ([a-z][a-z-]*)\b/g)].map((match) => match[1]));
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
    expect(codeIn(hubStep()).find((code) => code.startsWith("coder create "))).toBe("coder create <name> --template <template> --preset none --use-parameter-defaults --parameter <disk parameter>=<200 or 500> --yes\n");
  });

  test("with a hub and a node, reads the template's parameters when coder templates pull fails", () => {
    expect(words(hubStep())).toContain("When `coder templates pull` fails, open the template's page in the Coder web app");
  });

  test("with a hub and a node, follows a team pack's own setup note first, at the path where setup keeps that team's pack", async () => {
    expect(words(hubStep())).toContain("When step 7 printed that a team pack is ticked");
    const notePath = codeIn(hubStep()).find((code) => code.includes("/packs/<pack>/SETUP.md"))?.trim();
    const home = temp.make("home-");
    const cached = join(sourceCache(home), "team", "packs", "hub");
    cpSync(join(root, "packs", "hub"), cached, { recursive: true });
    mkdirSync(join(sourceCache(home), "team", ".git"));
    const source = await cachedSource({ name: "team", repo: "example/team-pack", ref: "main" }, sourceCache(home));
    const pack = "packs" in source ? source.packs.find((loaded) => loaded.manifest.name === "hub") : undefined;
    const guidePathOfNote = notePath?.replace("~", home).replace("<source>", "team").replace("<pack>", "hub");
    expect(guidePathOfNote).toBe(join(pack!.dir, "SETUP.md"));
    expect(existsSync(guidePathOfNote!)).toBe(true);
  });

  test("with a hub and a node, keeps both running while the Mac sleeps", () => {
    expect(codeIn(hubStep())).toContain("coder schedule stop <name> manual");
  });

  test("with a hub and a node, checks each workspace with a fleet doctor that sets the guide's PATH over SSH", () => {
    expect(codeIn(hubStep())).toContain(`ssh coder.<name> 'export PATH="${guidePath}"; fleet doctor'\n`);
  });

  test("with a hub and a node, says how to add a node later", () => {
    expect(words(hubStep())).toContain("To add a node later, when the load grows, run steps 3, 4, 5 and 9 again with a new name and a 500 GB disk");
  });

  test("with a hub and a node, installs Fleet on the hub, names it the hub there, turns the hub packs on, and only then adds the node", () => {
    const code = codeIn(hubStep()).join("\n");
    const order = [
      code.indexOf("fleet devbox add %s\\n' 'coder.<hub>'"),
      code.indexOf(`ssh coder.<hub> 'export PATH="${guidePath}"; fleet hub here'`),
      code.indexOf("fleet packs --add hub --workflows boxes=off"),
      code.indexOf(`ssh coder.<hub> 'export PATH="${guidePath}"; fleet update'`),
      code.indexOf("fleet devbox add %s\\n' 'coder.<node>'"),
    ];
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("says how to use each line the page's prompt can carry", async () => {
    const data = await pageData({ audience: "public" });
    const picks = setSetting(data, toggleWorkflow(data, toggleWorkflow(data, presetPicks(data, "everything", {}, "hub"), "nightly-updates"), "dream"), "base.heavySlots", 4);
    const prompt = promptText(data, picks);
    const labels = [...prompt.matchAll(/^- ([^:]+): /gm)].map((match) => match[1]!);
    expect(new Set(labels)).toEqual(new Set(Object.values(promptLabels).filter((label) => label !== promptLabels.intro)));
    const [, intro] = prompt.split("\n\n");
    expect(words(guide())).toContain(`\`${intro!.split("\n")[0]}\``);
    const rows = [...guide().matchAll(/^\| `([^`|]+)` \| [^|]+ \|$/gm)].map((match) => match[1]!);
    expect(labels.filter((label) => !rows.includes(label))).toEqual([]);
  });

  test("lets the page's workflow lines win over a setup note, and turns on no hub pack when the page names none", () => {
    const text = words(guide());
    expect(text).toContain("Add no workflow flag from a setup note");
    expect(text).toContain("the line's value wins");
    expect(text).toContain("`none` means no pack, so skip item 8");
    expect(text).toContain("leave out `--add hub` when the line does not name `hub`");
  });

  test("offers in step 9 the packs the page keeps for a hub, and Slack with Mac only or in step 9", () => {
    const offer = (name: string) => guide().match(new RegExp(`^\\| \`${name}\` \\| [^|]+ \\| ([^|]+) \\|`, "m"))?.[1];
    expect(needsHubPacks.map(offer)).toEqual(needsHubPacks.map(() => "Step 9"));
    expect(prefersHubPacks.map(offer)).toEqual(prefersHubPacks.map(() => "With Mac only, or in step 9"));
    const others = packRows().map((row) => row.name).filter((name) => ![...needsHubPacks, ...prefersHubPacks].includes(name));
    expect(others.map(offer)).toEqual(others.map(() => "Always"));
  });

  test("offers the Hub pack and the packs that need a running hub in step 9, each with its setup note", () => {
    const later = packRows().filter((row) => ["hub", "mcp-gateway", "recovery"].includes(row.name));
    expect(later.map((row) => row.note)).toEqual(["`packs/recovery/SETUP.md`", "`packs/hub/SETUP.md`", "`packs/mcp-gateway/SETUP.md`"]);
    for (const name of ["hub", "mcp-gateway", "recovery", "slack"]) expect(words(hubStep())).toContain(`\`packs/${name}/SETUP.md\``);
  });

  test("gives every command in the guide and the pack notes the same PATH, with Bun's Homebrew folders on it", () => {
    const notes = readdirSync(join(root, "packs")).map((pack) => join(root, "packs", pack, "SETUP.md")).filter(existsSync);
    const paths = [guide(), ...notes.map((path) => readFileSync(path, "utf8"))].flatMap((text) => [...text.matchAll(/export PATH="([^"]+)"/g)].map((match) => match[1]));
    expect(paths.length).toBeGreaterThan(1);
    expect(new Set(paths)).toEqual(new Set([guidePath]));
  });

  test("fetches only files that are in the repo", () => {
    const paths = [...guide().matchAll(/https:\/\/raw\.githubusercontent\.com\/Silthus\/fleet-engine\/main\/(\S+?)[`)\s]/g)].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });
});
