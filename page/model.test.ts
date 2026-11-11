import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AvailableSource } from "../src/pack/types.ts";
import { readFileSync } from "node:fs";
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
  chosen,
  runState,
  workflowState,
  presetPicks,
  profileFile,
  questions,
  promptText,
  setSetting,
  setupAsks,
  setupSplit,
  setWhere,
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
      toggleWorkflow(data, presetPicks(data, "everything"), "signal-loop"),
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
    let everything = presetPicks(data, "starter");
    for (const id of ["orchestration", "communication", "memory", "guards", "slack"]) everything = togglePack(data, everything, id);
    for (const id of ["quality-loop", "signal-loop", "pr-digest", "shell-guards", "package-age"]) everything = toggleWorkflow(data, everything, id);
    expect(activePreset(data, everything)?.id).toBe("everything");
    expect(commandFlags(data, everything)).toEqual(["--preset", "everything"]);
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

  test("a workflow of a pack that is off is off, and names the pack that turns it on", () => {
    const off = togglePack(data, everyday(), "orchestration");
    expect(["maps", "side-threads"].map((id) => workflowState(data, off, workflow(id)))).toEqual([
      { on: false, fix: { pack: "orchestration" } },
      { on: false, fix: { pack: "orchestration" } },
    ]);
    expect(workflowState(data, everyday(), workflow("maps"))).toEqual({ on: true });
    expect(workflowState(data, everyday(), workflow("quality-loop"))).toEqual({ on: false, fix: { workflow: "quality-loop" } });
  });

  test("a workflow that needs a pack stays off until that pack is on", () => {
    const hub: PageData = {
      ...data,
      packs: [...data.packs, { name: "hub", title: "Hub", summary: "", requires: [], always: false, workflows: [{ id: "boxes", name: "Boxes", sentence: "Boxes.", needs: ["hub"], requires: [], default: true, settings: [] }], settings: [] }],
      needPacks: { hub: "hub" },
      needsHubPacks: [],
    };
    const boxes = (packs: Picks) => workflowState(hub, packs, { id: "boxes", name: "Boxes", sentence: "Boxes.", needs: ["hub"], requires: [], default: true, settings: [] }, "hub");
    const picks = presetPicks(hub, "everyday");
    expect(workflowState(hub, picks, hub.packs.at(-1)!.workflows[0]!)).toEqual({ on: false, fix: { pack: "hub" } });
    expect(boxes(togglePack(hub, picks, "hub"))).toEqual({ on: true });
  });

  test("a workflow that requires another stays off until that one is on, and turning it on or off carries the workflows it requires or that require it", () => {
    const flow = (id: string, requires: string[], fields: Partial<PageData["packs"][number]["workflows"][number]> = {}) => ({ id, name: id.toUpperCase(), sentence: `${id}.`, needs: [], requires, default: false, settings: [], ...fields });
    const gate: PageData = {
      ...data,
      packs: [...data.packs, { name: "gate", title: "Gate", summary: "", requires: [], always: true, workflows: [flow("gateway", [], { default: true }), flow("mail", ["gateway"]), flow("ping", ["pong"]), flow("pong", ["ping"])], settings: [] }],
    };
    const state = (picks: Picks, id: string) => workflowState(gate, picks, gate.packs.at(-1)!.workflows.find((item) => item.id === id)!);
    const start = presetPicks(gate, "everyday");
    const unmet = { ...start, workflows: { ...start.workflows, gateway: false, mail: true } };
    expect(state(unmet, "mail")).toEqual({ on: false, fix: { workflow: "gateway" } });
    const mailOn = toggleWorkflow(gate, { ...start, workflows: { ...start.workflows, gateway: false } }, "mail");
    expect([mailOn.workflows.gateway, mailOn.workflows.mail, state(mailOn, "mail")]).toEqual([true, true, { on: true }]);
    const gatewayOff = toggleWorkflow(gate, mailOn, "gateway");
    expect([gatewayOff.workflows.gateway, gatewayOff.workflows.mail]).toEqual([false, false]);
    const cycle = toggleWorkflow(gate, start, "ping");
    expect([state(cycle, "ping"), state(cycle, "pong")]).toEqual([{ on: true }, { on: true }]);
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
    const everything = presetPicks(data, "everything");
    expect(setupAsks(data, everything)).toBe("asks 1 more question, plus 4 when you add a devbox");
    expect(setupAsks(data, setSetting(data, everything, "orchestration.loopProject", "app"))).toBe("asks 1 more question, plus 3 when you add a devbox");
    expect(setupAsks(data, presetPicks(data, "starter"))).toBe("asks 1 more question");
  });

  test("count the AI plans question, and keep the settings only a devbox asks apart until the command answers them", () => {
    const everything = presetPicks(data, "everything");
    const before = questions(data, everything);
    expect(before.count).toBe(before.settings.length + 1);
    expect(before.devbox.map((setting) => setting.key)).toEqual(["orchestration.loopProject", "orchestration.qualityArea", "orchestration.criticalPaths", "orchestration.ledgerRepo"]);
    const after = questions(data, setSetting(data, everything, "orchestration.loopProject", "app"));
    expect([after.count, after.devbox.map((setting) => setting.key)]).toEqual([before.count, ["orchestration.qualityArea", "orchestration.criticalPaths", "orchestration.ledgerRepo"]]);
  });
});

describe("where Fleet runs", () => {
  const optional = () => data.packs.filter((pack) => !pack.always).map((pack) => pack.name);

  test("Everything holds every pack once there is a hub, and every pack a Mac can run with Mac only", () => {
    expect(presetPicks(data, "everything", {}, "hub").packs.toSorted()).toEqual(optional().toSorted());
    expect(presetPicks(data, "everything").packs.toSorted()).toEqual(optional().filter((name) => !data.needsHubPacks.includes(name)).toSorted());
    expect(data.needsHubPacks.length).toBeGreaterThan(0);
  });

  test("adding a hub turns on the preset's hub packs and keeps the preset, and Mac only drops every pack that needs a hub", () => {
    const hub = setWhere(data, everyday(), "hub");
    expect([hub.where, hub.packs.toSorted(), activePreset(data, hub)?.id]).toEqual(["hub", ["communication", "hub", "orchestration", "pull-requests"], "everyday"]);
    const back = setWhere(data, togglePack(data, hub, "recovery"), "mac");
    expect([back.where, back.packs.toSorted(), activePreset(data, back)?.id]).toEqual(["mac", ["communication", "orchestration", "pull-requests"], "everyday"]);
  });

  test("Everything with a hub turns on the workflows that make Slack and Recovery do their work, and Mac only takes them back", () => {
    const hub = setWhere(data, presetPicks(data, "everything"), "hub");
    expect(["slack-thread", "provider-recovery", "own-account-balancing"].map((id) => runState(data, hub, workflow(id)))).toEqual([{ on: true }, { on: true }, { on: true }]);
    expect(activePreset(data, hub)?.id).toBe("everything");
    const back = setWhere(data, hub, "mac");
    expect([chosen(back, workflow("slack-thread")), activePreset(data, back)?.id, commandFlags(data, back)]).toEqual([false, "everything", ["--preset", "everything"]]);
  });

  test("going back to Mac only keeps a workflow the person turned on themselves", () => {
    const own = toggleWorkflow(data, presetPicks(data, "everything"), "slack-thread");
    const back = setWhere(data, setWhere(data, own, "hub"), "mac");
    expect([chosen(back, workflow("slack-thread")), chosen(back, workflow("provider-recovery"))]).toEqual([true, false]);
    const hub = presetPicks(data, "everything", {}, "hub");
    const again = toggleWorkflow(data, toggleWorkflow(data, hub, "slack-thread"), "slack-thread");
    expect(chosen(setWhere(data, again, "mac"), workflow("slack-thread"))).toBe(true);
  });

  test("a pack that needs a hub stays off with Mac only", () => {
    expect(togglePack(data, everyday(), "hub")).toEqual(everyday());
    expect(togglePack(data, setWhere(data, everyday(), "hub"), "recovery").packs).toContain("recovery");
  });

  test("with Mac only, a workflow that needs a devbox or the hub waits for a hub and a node", () => {
    const loop = toggleWorkflow(data, everyday(), "quality-loop");
    expect(runState(data, loop, workflow("quality-loop"))).toEqual({ on: false, fix: { where: "hub" } });
    expect(runState(data, setWhere(data, loop, "hub"), workflow("quality-loop"))).toEqual({ on: true });
    expect(runState(data, everyday(), workflow("disk-watch"))).toEqual({ on: false, fix: { where: "hub" } });
    expect(runState(data, setWhere(data, everyday(), "hub"), workflow("disk-watch"))).toEqual({ on: true });
    expect(runState(data, everyday(), workflow("maps"))).toEqual({ on: true });
    expect(runState(data, everyday(), workflow("shared-memory"))).toEqual({ on: false, fix: { pack: "memory" } });
  });

  test("the command by hand sets up the first machine, so it leaves out the packs that wait for the hub", () => {
    expect(commandFlags(data, presetPicks(data, "everything", {}, "hub"))).toEqual(["--preset", "everything", "--remove", "slack"]);
    expect(commandFlags(data, setWhere(data, everyday(), "hub"))).toEqual(["--preset", "everyday"]);
  });
});

describe("the prompt", () => {
  const readmePrompt = () => readFileSync(join(import.meta.dir, "../README.md"), "utf8").match(/```text\n\s*(Set up Fleet[^\n]+)\n/)![1]!;
  const line = (text: string, label: string) => text.match(new RegExp(`^- ${label}: (.*)$`, "m"))?.[1];

  test("opens with the README's prompt, so both start the same setup guide", () => {
    expect(promptText(data, everyday()).split("\n")[0]).toBe(readmePrompt());
  });

  test("with Mac only, names where Fleet runs and the packs for the first setup", () => {
    expect(promptText(data, everyday())).toBe(`${readmePrompt()}\n\nMy picks from the Fleet page:\n- Where Fleet runs: Mac only\n- Packs on the first setup: pull-requests, orchestration, communication`);
  });

  test("with a hub, keeps the packs that need one, and Slack, for once the hub runs, each with its own workflows", () => {
    const picks = toggleWorkflow(data, presetPicks(data, "everything", {}, "hub"), "dream");
    expect(promptText(data, picks).split("\n").slice(2)).toEqual([
      "My picks from the Fleet page:",
      "- Where Fleet runs: Mac plus a hub and a node",
      "- Packs on the first setup: pull-requests, orchestration, communication, memory, guards",
      "- Workflows on the first setup: quality-loop=on, signal-loop=on, pr-digest=on, shell-guards=on, package-age=on",
      "- Packs once the hub runs: hub, mcp-gateway, recovery, slack",
      "- Workflows once the hub runs: slack-thread=on, disk-watch=on, linked-hub=on, dream=on, own-account-balancing=on, mcp-gateway=on, provider-recovery=on",
    ]);
  });

  test("for the hub, names every workflow that is on or starts on, so the list alone says what runs", () => {
    const hub = presetPicks(data, "everything", {}, "hub");
    expect(line(promptText(data, hub), "Workflows once the hub runs")).toBe("slack-thread=on, disk-watch=on, linked-hub=on, own-account-balancing=on, mcp-gateway=on, provider-recovery=on");
    const quiet = toggleWorkflow(data, toggleWorkflow(data, hub, "slack-thread"), "mcp-gateway");
    expect(line(promptText(data, quiet), "Workflows once the hub runs")).toBe("disk-watch=on, linked-hub=on, own-account-balancing=on, mcp-gateway=off, provider-recovery=on");
  });

  test("names no pack as none, and carries each changed setting on its own line", () => {
    const bare = togglePack(data, presetPicks(data, "starter"), "pull-requests");
    expect(line(promptText(data, bare), "Packs on the first setup")).toBe("none");
    const tuned = setSetting(data, setSetting(data, everyday(), "base.heavySlots", 4), "pull-requests.mergeCommand", "gh pr merge --squash, now");
    expect(promptText(data, tuned).split("\n").slice(-2)).toEqual(["- Setting: base.heavySlots=4", "- Setting: pull-requests.mergeCommand=gh pr merge --squash, now"]);
  });

  test("its first setup picks, as the guide's one by one command, are read by setup as the packs and workflows the page shows", async () => {
    const tuned = [
      everyday(),
      togglePack(data, presetPicks(data, "starter"), "pull-requests"),
      toggleWorkflow(data, presetPicks(data, "everything"), "nightly-updates"),
      toggleWorkflow(data, presetPicks(data, "everything", {}, "hub"), "slack-thread"),
      setSetting(data, togglePack(data, everyday(), "memory"), "base.heavySlots", 4),
    ];
    const catalog = await loadCatalog(join(import.meta.dir, ".."), [], temp.make("home-"));
    for (const picks of tuned) {
      const text = promptText(data, picks);
      const packs = line(text, "Packs on the first setup")!.split(", ").filter((name) => name !== "none");
      const flags = ["--preset", "starter", ...(packs.includes("pull-requests") ? [] : ["--remove", "pull-requests"]), ...packs.filter((name) => name !== "pull-requests").flatMap((name) => ["--add", name])];
      const workflows = line(text, "Workflows on the first setup");
      if (workflows) flags.push("--workflows", workflows.replaceAll(", ", ","));
      for (const [, pair] of text.matchAll(/^- Setting: (.*)$/gm)) flags.push("--set", pair!);
      const parsed = parseSetupFlags(flags);
      const read = picksFrom(parsed, catalog);
      const first = setupSplit(data, picks).first;
      const shown = data.packs.filter((pack) => pack.always || first.includes(pack.name)).flatMap((pack) => pack.workflows);
      expect({ text, packs: read.packs.toSorted(), workflows: shown.map((item) => [item.id, read.workflows[item.id] ?? item.default]) }).toEqual({ text, packs: first.toSorted(), workflows: shown.map((item) => [item.id, chosen(picks, item)]) });
      expect([text, settingsFrom(parsed, catalog)]).toEqual([text, Object.fromEntries(Object.entries(picks.settings))]);
    }
  });
});
