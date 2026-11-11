import type { Need, PackSetting } from "../src/pack/types.ts";

export type PageWorkflow = { id: string; name: string; sentence: string; needs: Need[]; default: boolean; risk?: string };

export type PromptPack = { name: string; title: string; requires: string[]; always: boolean; setupNote?: string };

export type PagePack = PromptPack & { summary: string; cost?: string; risk?: string; workflows: PageWorkflow[]; settings: PackSetting[] };

export type PromptData<Pack extends PromptPack = PromptPack> = {
  engineRepo: string;
  packs: Pack[];
  teamPacks: string[];
  startPacks: string[];
  hubStartPacks: string[];
  needsHubPacks: string[];
};

export type PageData = PromptData<PagePack> & { needLabels: Partial<Record<Need, string>> };

export type Where = "mac" | "hub";

export type Start = { where: Where; off: string[] };

export const wheres: Where[] = ["mac", "hub"];

export const firstStart: Start = { where: "mac", off: [] };

export const whereLabels: Record<Where, string> = { mac: "Mac only", hub: "Mac plus a hub and a node" };

export const promptLabels = {
  intro: "My picks from the Fleet page:",
  where: "Where Fleet runs",
  firstPacks: "Packs on the first setup",
  laterPacks: "Packs once the hub runs",
};

export const noPack = "none";

export const listed = (words: string[]) => (words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`);

export function promptData(data: PromptData): PromptData {
  const { engineRepo, teamPacks, startPacks, hubStartPacks, needsHubPacks } = data;
  const packs = data.packs.map(({ name, title, requires, always, setupNote }) => ({ name, title, requires, always, ...(setupNote ? { setupNote } : {}) }));
  return { engineRepo, packs, teamPacks, startPacks, hubStartPacks, needsHubPacks };
}

function inPageOrder(data: PromptData, names: Iterable<string>) {
  const wanted = new Set(names);
  return data.packs.map((pack) => pack.name).filter((name) => wanted.has(name));
}

export function toggleSelected(data: PromptData, selected: string[], name: string): string[] {
  const packs = new Set(selected);
  const drop = (target: string) => {
    packs.delete(target);
    for (const pack of data.packs) if (packs.has(pack.name) && pack.requires.includes(target)) drop(pack.name);
  };
  const add = (target: string) => {
    const pack = data.packs.find((item) => item.name === target);
    if (!pack || pack.always || packs.has(target)) return;
    packs.add(target);
    pack.requires.forEach(add);
  };
  if (packs.has(name)) drop(name);
  else add(name);
  return inPageOrder(data, packs);
}

export const startPacksOn = (data: PromptData, start: Start) => data.startPacks.filter((name) => !start.off.includes(name));

export function toggleStart(data: PromptData, start: Start, name: string): Start {
  if (!data.startPacks.includes(name)) return start;
  const on = toggleSelected(data, startPacksOn(data, start), name);
  return { ...start, off: data.startPacks.filter((pack) => !on.includes(pack)) };
}

export function setupSplit(data: PromptData, start: Start) {
  return { first: inPageOrder(data, [...startPacksOn(data, start), ...data.teamPacks]), later: start.where === "hub" ? inPageOrder(data, data.hubStartPacks) : [] };
}

export function startPrompt(data: PromptData, start: Start) {
  const { first, later } = setupSplit(data, start);
  return [
    `Set up Fleet on this Mac with me. Read https://raw.githubusercontent.com/${data.engineRepo}/main/SETUP.md and follow it step by step.`,
    "",
    promptLabels.intro,
    `- ${promptLabels.where}: ${whereLabels[start.where]}`,
    `- ${promptLabels.firstPacks}: ${first.join(", ") || noPack}`,
    ...(start.where === "hub" ? [`- ${promptLabels.laterPacks}: ${later.join(", ") || noPack}`] : []),
  ].join("\n");
}

export const installCommand = (selected: string[]) => `fleet packs ${selected.map((name) => `--add ${name}`).join(" ")}`;

function hubStep(data: PromptData, titles: string[]) {
  const one = titles.length === 1;
  return `${one ? "This pack needs" : "These packs need"} a hub: ${listed(titles)}. Run \`fleet hub status\`. When it prints "The hub: not named", I have no hub yet. Tell me, leave ${one ? "that pack" : "those packs"} out, and offer to add a hub and a node first with step 9 of https://raw.githubusercontent.com/${data.engineRepo}/main/SETUP.md. Otherwise the name after "The hub:" is the SSH name of the hub. Use it as the host of each SSH command in a note.`;
}

function noteStep(notes: PromptPack[]) {
  const source = notes.some((pack) => pack.setupNote!.includes("<source>")) ? ["   `<source>` is the folder in `~/.local/share/fleet/sources` that holds the pack."] : [];
  return [
    'Read the setup note of each pack. Ask me what it asks, and collect the flags that it names. Where a note names "the setup command" or "the command in step 9", use the `fleet packs` command of this prompt. Do not run a step that a note puts after that command yet.',
    ...notes.map((pack) => `   - ${pack.title}: ${pack.setupNote}`),
    ...source,
  ].join("\n");
}

export function installPrompt(data: PromptData, selected: string[]) {
  const packs = data.packs.filter((pack) => selected.includes(pack.name));
  if (!packs.length) return "";
  const notes = packs.filter((pack) => pack.setupNote);
  const onHub = packs.filter((pack) => data.needsHubPacks.includes(pack.name)).map((pack) => pack.title);
  const steps = [
    "Run `fleet update`, so this machine has the newest engine and packs. Then run `fleet packs`, and leave out each pack that is already on.",
    ...(onHub.length ? [hubStep(data, onHub)] : []),
    ...(notes.length ? [noteStep(notes)] : []),
    `Turn the packs on with one command${notes.length ? ", and add the flags that the notes name" : ""}:\n   ${installCommand(packs.map((pack) => pack.name))}`,
    ...(onHub.length ? ["Run `fleet update` on the hub over SSH, so the hub has the packs before a note's next step needs them."] : []),
    ...(notes.length ? ["Do the steps that each note puts after the command."] : []),
    "Run `fleet doctor`, and explain each line. Do each `To do:` line with me, and say what a sign-in is for before it opens.",
    "My other machines take the change at their next `fleet update`. To give it to one now, run `fleet update` there.",
  ];
  return [
    `Add ${packs.length === 1 ? "this Fleet pack" : "these Fleet packs"} to my setup with me: ${listed(packs.map((pack) => pack.title))}.`,
    "",
    "Fleet already runs on this machine. Ask me each choice with your question tool, and run every command yourself.",
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ].join("\n");
}
