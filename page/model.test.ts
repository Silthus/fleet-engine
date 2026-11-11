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
import { firstStart, installPrompt, setupSplit, startPrompt, toggleExtra, toggleSelected, type PageData, type Start } from "./model.ts";

isolateGit();
const temp = tempDirs();
afterEach(() => temp.cleanup());
let data: PageData;
beforeAll(async () => {
  data = await pageData({ audience: "public" });
});

const root = join(import.meta.dir, "..");
const withHub: Start = { where: "hub", extras: [] };
const extras = (start: Start, ...names: string[]) => names.reduce((picked, name) => toggleExtra(data, picked, name), start);
const select = (...names: string[]) => names.reduce((selected, name) => toggleSelected(data, selected, name), [] as string[]);
const line = (text: string, label: string) => text.match(new RegExp(`^- ${label}: (.*)$`, "m"))?.[1];

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
  return new Set([...shipped, ...[...usage.matchAll(/^ {2}fleet ([a-z][a-z-]*)/gm)].map((match) => match[1]!)]);
}

describe("the Getting started prompt", () => {
  const readmePrompt = () => readFileSync(join(root, "README.md"), "utf8").match(/```text\n\s*(Set up Fleet[^\n]+)\n/)![1]!;

  test("with Mac only, is the README's prompt plus where Fleet runs and the packs that are on by default", () => {
    expect(startPrompt(data, firstStart)).toBe(`${readmePrompt()}\n\nMy picks from the Fleet page:\n- Where Fleet runs: Mac only\n- Packs on the first setup: pull-requests, orchestration, communication`);
  });

  test("with a hub and a node, changes only the place and adds the Hub pack for once the hub runs", () => {
    const mac = startPrompt(data, firstStart).split("\n");
    const hub = startPrompt(data, withHub).split("\n");
    expect(hub.filter((text) => !mac.includes(text))).toEqual(["- Where Fleet runs: Mac plus a hub and a node", "- Packs once the hub runs: hub"]);
    expect(mac.filter((text) => !hub.includes(text))).toEqual(["- Where Fleet runs: Mac only"]);
  });

  test("offers at most three extras, each a pack that a Mac can run and that is off by default", () => {
    expect(data.extraPacks).toEqual(["memory", "guards", "slack"]);
    expect(data.extraPacks.length).toBeLessThanOrEqual(3);
    expect(data.extraPacks.filter((name) => data.startPacks.includes(name) || data.needsHubPacks.includes(name))).toEqual([]);
  });

  test("puts an extra on the first setup, and keeps Slack for the hub when there is one", () => {
    expect(line(startPrompt(data, extras(firstStart, "slack", "memory")), "Packs on the first setup")).toBe("pull-requests, orchestration, communication, memory, slack");
    const hub = startPrompt(data, extras(withHub, "slack", "guards"));
    expect(line(hub, "Packs on the first setup")).toBe("pull-requests, orchestration, communication, guards");
    expect(line(hub, "Packs once the hub runs")).toBe("hub, slack");
  });

  test("takes an extra back, and takes no pack that is not an extra", () => {
    expect(extras(firstStart, "memory", "memory")).toEqual(firstStart);
    expect(extras(firstStart, "recovery", "pull-requests", "base")).toEqual(firstStart);
  });

  test("its first setup packs, as the guide's one by one command, are the packs setup turns on", async () => {
    const catalog = await loadCatalog(root, [], temp.make("home-"));
    for (const start of [firstStart, extras(firstStart, "memory", "guards", "slack"), extras(withHub, "slack", "memory")]) {
      const packs = line(startPrompt(data, start), "Packs on the first setup")!.split(", ");
      const flags = ["--preset", "starter", ...(packs.includes("pull-requests") ? [] : ["--remove", "pull-requests"]), ...packs.filter((name) => name !== "pull-requests").flatMap((name) => ["--add", name])];
      expect(picksFrom(parseSetupFlags(flags), catalog).packs.toSorted()).toEqual(setupSplit(data, start).first.toSorted());
    }
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
        '2. Read the setup note of each pack, and follow it. Where a note names "the setup command" or "the command in step 9", use the `fleet packs` command of this prompt.',
        "   - Memory: ~/.local/share/fleet/engine/packs/memory/SETUP.md",
        "   - Guards: ~/.local/share/fleet/engine/packs/guards/SETUP.md",
        "3. Turn the packs on with one command, and add the flags that the notes name:",
        "   fleet packs --add communication --add memory --add guards",
        "4. Run `fleet doctor`, and explain each line. Do each `To do:` line with me, and say what a sign-in is for before it opens.",
        "5. My other machines take the change at their next `fleet update`. To give it to one now, run `fleet update` there, the hub first.",
      ].join("\n"),
    );
  });

  test("for one pack without a setup note, names that pack alone and no note", () => {
    const text = installPrompt(data, select("communication"));
    expect(text.split("\n")[0]).toBe("Add this Fleet pack to my setup with me: Communication.");
    expect(text).not.toContain("setup note");
    expect(text).toContain("   fleet packs --add communication\n");
  });

  test("selecting a pack selects the packs it requires, and taking one back takes back the packs that require it", () => {
    expect(select("orchestration")).toEqual(["pull-requests", "orchestration"]);
    expect(select("orchestration", "memory", "pull-requests")).toEqual(["memory"]);
    expect(select("base")).toEqual([]);
  });

  test("for a pack that needs a hub, says so, and says what to do in a fleet without a hub, in the words fleet hub status prints", async () => {
    const text = installPrompt(data, select("memory", "recovery", "hub"));
    const step = text.split("\n").find((item) => item.startsWith("3. "))!;
    expect(step).toBe(
      '3. These packs need a hub: Hub and Recovery. Run `fleet hub status`. When it prints "The hub: not named", I have no hub yet. Tell me, leave those packs out, and offer to add a hub and a node first with step 9 of https://raw.githubusercontent.com/Silthus/fleet-engine/main/SETUP.md. Otherwise the name after "The hub:" is the SSH name of the hub. Use it as the host of each SSH command in a note.',
    );
    expect(installPrompt(data, select("recovery"))).toContain("3. This pack needs a hub: Recovery.");
    expect(installPrompt(data, select("recovery"))).toContain("leave that pack out");
    expect(installPrompt(data, select("memory", "slack"))).not.toContain("hub status");
    const mac = await macWithFleet();
    expect(await mac.fleet(["hub", "status"])).toBe(0);
    expect(mac.output()).toContain("\nThe hub: not named.");
    expect(readFileSync(join(root, "SETUP.md"), "utf8")).toContain("\n## 9. Add the hub and the node\n");
  });

  test("names only fleet commands that exist", async () => {
    const known = await fleetCommands();
    const everyPack = data.packs.map((pack) => pack.name).reduce((selected, name) => toggleSelected(data, selected, name), [] as string[]);
    const used = [...installPrompt(data, everyPack).matchAll(/\bfleet ([a-z][a-z-]*)\b/g)].map((match) => match[1]!);
    expect(new Set(used)).toEqual(new Set(["update", "packs", "hub", "doctor"]));
    expect(used.filter((command) => !known.has(command))).toEqual([]);
  });

  test("names the setup note of every pack that has one, at the path where a machine that runs Fleet keeps it", () => {
    const everyPack = data.packs.map((pack) => pack.name).reduce((selected, name) => toggleSelected(data, selected, name), [] as string[]);
    const named = [...installPrompt(data, everyPack).matchAll(/^ {3}- [^:]+: ~\/\.local\/share\/fleet\/engine\/(\S+)$/gm)].map((match) => match[1]!);
    const held = readdirSync(join(root, "packs")).filter((pack) => existsSync(join(root, "packs", pack, "SETUP.md")));
    expect(named.toSorted()).toEqual(held.map((pack) => `packs/${pack}/SETUP.md`).toSorted());
  });

  test("its command turns the selected packs on in the profile of a machine that runs Fleet", async () => {
    const mac = await macWithFleet();
    const selected = select("communication", "guards");
    const command = installPrompt(data, selected).match(/^ {3}fleet (packs .*)$/m)![1]!;
    expect(await mac.fleet(command.split(" "))).toBe(0);
    expect((await pushedAnswers(mac.home)).packs).toEqual(expect.arrayContaining(selected));
  });
});
