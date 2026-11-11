import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { loadPacks } from "../src/pack/manifest.ts";
import { parseSetupFlags } from "../src/setup/flags.ts";
import { picksFrom } from "../src/setup/questions.ts";
import { loadCatalog } from "../src/setup/setup.ts";
import { engineRoot, fakeMachine, fleetSetup, pushedAnswers, scripted } from "../src/setup/testing.ts";
import { isolateGit, tempDirs } from "../src/testing/git.ts";
import { pageData } from "../scripts/build-page.ts";
import { firstStart, installPrompt, promptData, setupSplit, startPrompt, toggleSelected, toggleStart, type PageData, type Start } from "./model.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());
let data: PageData;
beforeAll(async () => {
  data = await pageData({ audience: "public" });
});

const root = join(import.meta.dir, "..");
const withHub: Start = { where: "hub", off: [] };
const flip = (start: Start, ...names: string[]) => names.reduce((picked, name) => toggleStart(data, picked, name), start);
const select = (...names: string[]) => names.reduce((selected, name) => toggleSelected(data, selected, name), [] as string[]);
const everyPack = () => select(...data.packs.map((pack) => pack.name));
const line = (text: string, label: string) => text.match(new RegExp(`^- ${label}: (.*)$`, "m"))?.[1];
const step = (text: string, start: string) => text.split("\n").find((item) => /^\d+\. /.test(item) && item.includes(start));

async function macWithFleet() {
  const home = temp.make("home-");
  expect((await fleetSetup(home, ["--non-interactive", "--preset", "starter", "--plan", "claude", "--devbox", "skip"], [], fakeMachine(home), undefined, 0, "darwin")).code).toBe(0);
  const io = scripted([]);
  const fleet = (args: string[]) => main(args, { home, engineRoot, platform: "darwin", print: io.terminal.print, terminal: io.terminal, apply: async () => 0, setup: { machine: fakeMachine(home).machine } });
  return { home, fleet, output: io.output };
}

async function fleetCommands() {
  let usage = "";
  await main(["help"], { home: "/nonexistent", engineRoot: root, platform: "darwin", print: (text) => (usage += `${text}\n`) });
  const commandFiles = (dir: string) => (existsSync(join(dir, "commands")) ? readdirSync(join(dir, "commands")).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => name.slice(0, -3)) : []);
  const shipped = (await loadPacks(root)).flatMap(({ dir, code }) => [...Object.keys(code?.commands ?? {}), ...commandFiles(dir)]);
  return new Set([...[...usage.matchAll(/^ {2}fleet ([a-z][a-z-]*)/gm)].map((match) => match[1]!), ...shipped]);
}

describe("the Getting started prompt", () => {
  const readmePrompt = () => readFileSync(join(root, "README.md"), "utf8").match(/```text\n\s*(Set up Fleet[^\n]+)\n/)![1]!;

  test("with Mac only, is the README's prompt plus where Fleet runs and the three packs that are on by default", () => {
    expect(startPrompt(data, firstStart)).toBe(`${readmePrompt()}\n\nMy picks from the Fleet page:\n- Where Fleet runs: Mac only\n- Packs on the first setup: pull-requests, orchestration, communication`);
  });

  test("with a hub and a node, changes only the place and adds the Hub pack for once the hub runs", () => {
    const mac = startPrompt(data, firstStart).split("\n");
    const hub = startPrompt(data, withHub).split("\n");
    expect(hub.filter((text) => !mac.includes(text))).toEqual(["- Where Fleet runs: Mac plus a hub and a node", "- Packs once the hub runs: hub"]);
    expect(mac.filter((text) => !hub.includes(text))).toEqual(["- Where Fleet runs: Mac only"]);
  });

  test("a pack that is switched off leaves the first setup, and comes back when it is switched on", () => {
    expect(line(startPrompt(data, flip(firstStart, "communication")), "Packs on the first setup")).toBe("pull-requests, orchestration");
    expect(flip(firstStart, "communication", "communication")).toEqual(firstStart);
    expect(line(startPrompt(data, flip(withHub, "communication")), "Packs once the hub runs")).toBe("hub");
  });

  test("with every pack switched off, the first setup names no pack", () => {
    expect(line(startPrompt(data, flip(firstStart, "pull-requests", "communication")), "Packs on the first setup")).toBe("none");
  });

  test("switching Pull requests off takes Orchestration with it, and switching Orchestration on brings Pull requests back", () => {
    const withoutPullRequests = flip(firstStart, "pull-requests");
    expect(line(startPrompt(data, withoutPullRequests), "Packs on the first setup")).toBe("communication");
    expect(line(startPrompt(data, flip(withoutPullRequests, "orchestration")), "Packs on the first setup")).toBe("pull-requests, orchestration, communication");
  });

  test("switches only the packs of the two boxes", () => {
    expect(data.startPacks).toEqual(["pull-requests", "orchestration", "communication"]);
    expect(data.hubStartPacks).toEqual(["hub"]);
    expect(flip(withHub, "hub", "memory", "base")).toEqual(withHub);
  });

  test("its first setup packs, as the guide's one by one command, are the packs setup turns on", async () => {
    const catalog = await loadCatalog(root, [], temp.make("home-"));
    for (const start of [firstStart, flip(firstStart, "orchestration"), flip(withHub, "pull-requests"), flip(firstStart, "pull-requests", "communication")]) {
      const packs = setupSplit(data, start).first;
      const flags = ["--preset", "starter", ...(packs.includes("pull-requests") ? [] : ["--remove", "pull-requests"]), ...packs.filter((name) => name !== "pull-requests").flatMap((name) => ["--add", name])];
      expect(picksFrom(parseSetupFlags(flags), catalog).packs.toSorted()).toEqual(packs.toSorted());
    }
  });

  test("the data a page carries builds the same prompts as the full pack data", () => {
    const carried = JSON.parse(JSON.stringify(promptData(data)));
    expect(startPrompt(carried, flip(withHub, "communication"))).toBe(startPrompt(data, flip(withHub, "communication")));
    expect(installPrompt(carried, everyPack())).toBe(installPrompt(data, everyPack()));
  });
});

describe("the install prompt", () => {
  test("is empty until a pack is selected", () => {
    expect(installPrompt(data, [])).toBe("");
  });

  test("names the selected packs, each setup note, and one fleet packs command that adds them", () => {
    expect(installPrompt(data, select("guards", "memory", "communication"))).toBe(
      [
        "Add these Fleet packs to my setup with me: Communication, Memory, and Guards.",
        "",
        "Fleet already runs on this machine. Ask me each choice with your question tool, and run every command yourself.",
        "",
        "1. Run `fleet update`, so this machine has the newest engine and packs. Then run `fleet packs`, and leave out each pack that is already on.",
        '2. Read the setup note of each pack. Ask me what it asks, and collect the flags that it names. Where a note names "the setup command" or "the command in step 9", use the `fleet packs` command of this prompt. Do not run a step that a note puts after that command yet.',
        "   - Memory: ~/.local/share/fleet/engine/packs/memory/SETUP.md",
        "   - Guards: ~/.local/share/fleet/engine/packs/guards/SETUP.md",
        "3. Turn the packs on with one command, and add the flags that the notes name:",
        "   fleet packs --add communication --add memory --add guards",
        "4. Do the steps that each note puts after the command.",
        "5. Run `fleet doctor`, and explain each line. Do each `To do:` line with me, and say what a sign-in is for before it opens.",
        "6. My other machines take the change at their next `fleet update`. To give it to one now, run `fleet update` there.",
      ].join("\n"),
    );
  });

  test("for one pack without a setup note, names that pack alone and no note", () => {
    const text = installPrompt(data, select("communication"));
    expect(text.split("\n")[0]).toBe("Add this Fleet pack to my setup with me: Communication.");
    expect(text).not.toMatch(/\bnotes?\b/);
    expect(text).toContain("3. Run `fleet doctor`");
    expect(text).toContain("2. Turn the packs on with one command:\n   fleet packs --add communication\n");
  });

  test("selecting a pack selects the packs it requires, and taking one back takes back the packs that require it", () => {
    expect(select("orchestration")).toEqual(["pull-requests", "orchestration"]);
    expect(select("orchestration", "memory", "pull-requests")).toEqual(["memory"]);
    expect(select("base")).toEqual([]);
  });

  test("for a pack that needs a hub, checks for the hub before it reads a note, in the words fleet hub status prints", async () => {
    const text = installPrompt(data, select("memory", "recovery", "hub"));
    expect(step(text, "need a hub")).toBe(
      '2. These packs need a hub: Hub and Recovery. Run `fleet hub status`. When it prints "The hub: not named", I have no hub yet. Tell me, leave those packs out, and offer to add a hub and a node first with step 9 of https://raw.githubusercontent.com/Silthus/fleet-engine/main/SETUP.md. Otherwise the name after "The hub:" is the SSH name of the hub. Use it as the host of each SSH command in a note.',
    );
    expect(installPrompt(data, select("recovery"))).toContain("2. This pack needs a hub: Recovery.");
    expect(installPrompt(data, select("recovery"))).toContain("leave that pack out");
    expect(installPrompt(data, select("memory", "slack"))).not.toContain("hub");
    const mac = await macWithFleet();
    expect(await mac.fleet(["hub", "status"])).toBe(0);
    expect(mac.output()).toContain("\nThe hub: not named.");
    expect(readFileSync(join(root, "SETUP.md"), "utf8")).toContain("\n## 9. Add the hub and the nodes\n");
  });

  test("for a pack that needs a hub, updates the hub after the command and before the steps a note puts after it", () => {
    const steps = installPrompt(data, select("recovery")).split("\n").filter((item) => /^\d+\. /.test(item)).map((item) => item.replace(/^\d+\. /, "").split(/[.,:]/)[0]);
    expect(steps).toEqual([
      "Run `fleet update`",
      "This pack needs a hub",
      "Read the setup note of each pack",
      "Turn the packs on with one command",
      "Run `fleet update` on the hub over SSH",
      "Do the steps that each note puts after the command",
      "Run `fleet doctor`",
      "My other machines take the change at their next `fleet update`",
    ]);
  });

  test("names only fleet commands that exist", async () => {
    const known = await fleetCommands();
    const used = [...installPrompt(data, everyPack()).matchAll(/\bfleet ([a-z][a-z-]*)\b/g)].map((match) => match[1]!);
    expect(new Set(used)).toEqual(new Set(["update", "packs", "hub", "doctor"]));
    expect(used.filter((command) => !known.has(command))).toEqual([]);
  });

  test("names the setup note of every pack that has one, at the path where a machine that runs Fleet keeps it", () => {
    const named = [...installPrompt(data, everyPack()).matchAll(/^ {3}- [^:]+: ~\/\.local\/share\/fleet\/engine\/(\S+)$/gm)].map((match) => match[1]!);
    const held = readdirSync(join(root, "packs")).filter((pack) => existsSync(join(root, "packs", pack, "SETUP.md")));
    expect(named.toSorted()).toEqual(held.map((pack) => `packs/${pack}/SETUP.md`).toSorted());
  });

  test("Memory's note gives a Fleet that already runs the flag that names the new memory repo, and the command of the prompt takes it", async () => {
    const note = readFileSync(join(root, "packs/memory/SETUP.md"), "utf8").replace(/\s+/g, " ");
    const flag = note.match(/On a Fleet that already runs, `fleet packs` creates no repo\. First run `gh repo create <their GitHub login>\/fleet-memory --private`, then add `(--set memory\.repo=<their GitHub login>\/fleet-memory)`/)![1]!;
    const mac = await macWithFleet();
    const command = installPrompt(data, select("memory")).match(/^ {3}fleet (packs .*)$/m)![1]!;
    expect(await mac.fleet([...command.split(" "), ...flag.replace("<their GitHub login>", "nora").split(" ")])).toBe(0);
    expect(await pushedAnswers(mac.home)).toMatchObject({ packs: expect.arrayContaining(["memory"]), settings: { "memory.repo": "nora/fleet-memory" } });
  });

  test("its command turns the selected packs on in the profile of a machine that runs Fleet", async () => {
    const mac = await macWithFleet();
    const selected = select("communication", "guards");
    const command = installPrompt(data, selected).match(/^ {3}fleet (packs .*)$/m)![1]!;
    expect(await mac.fleet(command.split(" "))).toBe(0);
    expect((await pushedAnswers(mac.home)).packs).toEqual(expect.arrayContaining(selected));
  });
});
