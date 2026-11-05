import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AvailableSource } from "../src/pack/types.ts";
import { parseSetupFlags } from "../src/setup/flags.ts";
import { filledBySetup, picksFrom, settingsFrom } from "../src/setup/questions.ts";
import { loadCatalog } from "../src/setup/setup.ts";
import { tempDirs } from "../src/testing/git.ts";
import { mac, engineSource, resolveEngine, skillSources } from "../src/testing/packs.ts";
import { pageData } from "../scripts/build-page.ts";
import {
  activePreset,
  commandFlags,
  commandText,
  momentState,
  presetPicks,
  profileFile,
  questions,
  setSetting,
  setupAsks,
  togglePack,
  toggleWorkflow,
  type PageData,
  type Picks,
} from "./model.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let data: PageData;
let engine: AvailableSource;
beforeAll(async () => {
  data = await pageData({ audience: "public" });
  engine = await engineSource();
});

const everyday = () => presetPicks(data, "everyday");
const workflow = (id: string) => data.packs.flatMap((pack) => pack.workflows).find((item) => item.id === id)!;

async function setupReads(picks: Picks) {
  const text = commandText(data, picks);
  const tail = text.slice(text.indexOf("sh -s -- --") + "sh -s -- --".length).replace(/\\\n\s*/g, "");
  const process = Bun.spawn(["sh", "-c", `printf '%s\\0' ${tail}`]);
  const words = (await new Response(process.stdout).text()).split("\0").slice(0, -1);
  const flags = parseSetupFlags(words);
  const catalog = await loadCatalog(join(import.meta.dir, ".."), [], temp.make("home-"));
  return { words, picks: picksFrom(flags, catalog), settings: settingsFrom(flags, catalog) };
}

describe("the command", () => {
  test("for each preset is one line that names only the preset", () => {
    expect(Object.fromEntries(data.presets.map((preset) => [preset.id, commandText(data, presetPicks(data, preset.id))]))).toMatchSnapshot();
  });

  test("carries Everyday plus Memory as --preset everyday --add memory", () => {
    const picks = togglePack(data, everyday(), "memory");
    expect(commandFlags(data, picks)).toEqual(["--preset", "everyday", "--add", "memory"]);
    expect(commandText(data, picks)).toStartWith("curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh | sh -s -- -- ");
  });

  test("is read back by setup as the same packs, workflows, and settings the page shows", async () => {
    const tuned = [
      everyday(),
      togglePack(data, everyday(), "memory"),
      togglePack(data, everyday(), "orchestration"),
      toggleWorkflow(data, presetPicks(data, "michael"), "signal-loop"),
      toggleWorkflow(data, togglePack(data, presetPicks(data, "starter"), "orchestration"), "quality-loop"),
      setSetting(data, setSetting(data, everyday(), "pull-requests.commentApproval", "all"), "pull-requests.mergeCommand", "gh pr merge --squash 'now'"),
      setSetting(data, everyday(), "base.heavySlots", 4),
    ];
    for (const picks of tuned) {
      const read = await setupReads(picks);
      const file = profileFile(data, picks);
      expect({ words: read.words, packs: read.picks.packs, workflows: read.picks.workflows, settings: read.settings }).toEqual({ words: read.words, packs: file.packs, workflows: file.workflows, settings: file.settings });
    }
  });

  test("names a preset the picks match exactly, and no flags for it", () => {
    const back = togglePack(data, togglePack(data, everyday(), "orchestration"), "orchestration");
    expect(activePreset(data, back)?.id).toBe("everyday");
    expect(commandFlags(data, back)).toEqual(["--preset", "everyday"]);
    let michael = togglePack(data, presetPicks(data, "starter"), "memory");
    for (const id of ["orchestration", "communication"]) michael = togglePack(data, michael, id);
    for (const id of ["quality-loop", "signal-loop", "pr-digest"]) michael = toggleWorkflow(data, michael, id);
    expect(activePreset(data, michael)?.id).toBe("michael");
    expect(commandFlags(data, michael)).toEqual(["--preset", "michael"]);
  });

  test("turns a workflow on or off against the preset, and quotes values for the shell", () => {
    const picks = setSetting(data, toggleWorkflow(data, toggleWorkflow(data, everyday(), "quality-loop"), "side-threads"), "pull-requests.mergeCommand", "gh pr merge --squash 'now'");
    expect(commandFlags(data, picks)).toEqual(["--preset", "everyday", "--workflows", "side-threads=off,quality-loop=on", "--set", "pull-requests.mergeCommand=gh pr merge --squash 'now'"]);
    expect(commandText(data, picks)).toContain(`--set 'pull-requests.mergeCommand=gh pr merge --squash '\\''now'\\'''`);
  });

  test("leaves out a setting at its default, and one whose workflow is off", () => {
    expect(commandFlags(data, setSetting(data, everyday(), "pull-requests.freeReviews", 2))).toEqual(["--preset", "everyday"]);
    expect(commandFlags(data, setSetting(data, everyday(), "orchestration.qualityArea", "src/billing"))).toEqual(["--preset", "everyday"]);
  });
});

describe("the picks", () => {
  test("adding a pack adds the packs it requires, and removing one removes the packs that require it", () => {
    const starter = presetPicks(data, "starter");
    expect(togglePack(data, togglePack(data, starter, "pull-requests"), "orchestration").packs.toSorted()).toEqual(["orchestration", "pull-requests"]);
    expect(togglePack(data, everyday(), "pull-requests").packs.toSorted()).toEqual(["communication"]);
  });

  test("a pack that is off fades its moments with a button that adds it back", () => {
    const off = togglePack(data, everyday(), "orchestration");
    expect(["maps", "side-threads"].map((id) => momentState(data, off, workflow(id)))).toEqual([
      { on: false, fix: { pack: "orchestration" } },
      { on: false, fix: { pack: "orchestration" } },
    ]);
    expect(momentState(data, everyday(), workflow("maps"))).toEqual({ on: true });
    expect(momentState(data, everyday(), workflow("quality-loop"))).toEqual({ on: false, fix: { workflow: "quality-loop" } });
  });

  test("a workflow that needs a pack stays off until that pack is on", () => {
    const hub: PageData = {
      ...data,
      packs: [...data.packs, { name: "hub", title: "Hub", summary: "", requires: [], always: false, workflows: [{ id: "boxes", name: "Boxes", sentence: "Boxes.", needs: ["hub"], default: true, settings: [] }], settings: [] }],
      needPacks: { hub: "hub" },
    };
    const boxes = (packs: Picks) => momentState(hub, packs, { id: "boxes", name: "Boxes", sentence: "Boxes.", needs: ["hub"], default: true, settings: [] }, "hub");
    const picks = presetPicks(hub, "everyday");
    expect(momentState(hub, picks, hub.packs.at(-1)!.workflows[0]!)).toEqual({ on: false, fix: { pack: "hub" } });
    expect(boxes(togglePack(hub, picks, "hub"))).toEqual({ on: true });
  });
});

describe("the questions setup still asks", () => {
  test("match the engine's own list on the Mac that runs the command, for each preset", () => {
    const skills = skillSources(temp.make("skills-"), engine);
    for (const preset of data.presets) {
      const picks = presetPicks(data, preset.id);
      const file = profileFile(data, picks);
      const plan = resolveEngine([engine, ...skills], { packs: file.packs, workflows: file.workflows }, mac);
      const engineAsks = plan.ask.map((setting) => setting.key).filter((key) => !filledBySetup.has(key));
      expect([preset.id, questions(data, picks).settings.map((setting) => setting.key).toSorted()]).toEqual([preset.id, engineAsks.toSorted()]);
      const devboxAsks = resolveEngine([engine, ...skills], { packs: file.packs, workflows: file.workflows }, { ...mac, role: "devbox" }).ask.map((setting) => setting.key).filter((key) => !filledBySetup.has(key) && !engineAsks.includes(key));
      expect([preset.id, questions(data, picks).devbox.map((setting) => setting.key).toSorted()]).toEqual([preset.id, devboxAsks.toSorted()]);
    }
  });

  test("say setup asks the settings only a devbox needs when you add one", () => {
    const michael = presetPicks(data, "michael");
    expect(setupAsks(data, michael)).toBe("asks 1 more question, plus 4 when you add a devbox");
    expect(setupAsks(data, setSetting(data, michael, "orchestration.loopProject", "app"))).toBe("asks 1 more question, plus 3 when you add a devbox");
    expect(setupAsks(data, presetPicks(data, "starter"))).toBe("asks 1 more question");
  });

  test("count the AI plans question, and keep the settings only a devbox asks apart until the command answers them", () => {
    const michael = presetPicks(data, "michael");
    const before = questions(data, michael);
    expect(before.count).toBe(before.settings.length + 1);
    expect(before.devbox.map((setting) => setting.key)).toEqual(["orchestration.loopProject", "orchestration.qualityArea", "orchestration.criticalPaths", "orchestration.ledgerRepo"]);
    const after = questions(data, setSetting(data, michael, "orchestration.loopProject", "app"));
    expect([after.count, after.devbox.map((setting) => setting.key)]).toEqual([before.count, ["orchestration.qualityArea", "orchestration.criticalPaths", "orchestration.ledgerRepo"]]);
  });
});
