import type { Need, PackSetting } from "../src/pack/types.ts";

export type PageWorkflow = { id: string; name: string; sentence: string; needs: Need[]; default: boolean; risk?: string };

export type PagePack = {
  name: string;
  title: string;
  summary: string;
  day?: string;
  cost?: string;
  risk?: string;
  requires: string[];
  always: boolean;
  setupNote?: string;
  workflows: PageWorkflow[];
  settings: PackSetting[];
};

export type Where = "mac" | "hub";

export type PageData = {
  engineRepo: string;
  packs: PagePack[];
  teamPacks: string[];
  startPacks: string[];
  hubStartPacks: string[];
  extraPacks: string[];
  needsHubPacks: string[];
  prefersHubPacks: string[];
  needPacks: Partial<Record<Need, string>>;
  needLabels: Partial<Record<Need, string>>;
  teamNote: string;
  overview: { image: string; alt: string };
};

export type Start = { where: Where; extras: string[] };

export const firstStart: Start = { where: "mac", extras: [] };

export const whereLabels: Record<Where, string> = { mac: "Mac only", hub: "Mac plus a hub and a node" };

export const promptLabels = {
  intro: "My picks from the Fleet page:",
  where: "Where Fleet runs",
  firstPacks: "Packs on the first setup",
  laterPacks: "Packs once the hub runs",
};

export const listed = (words: string[]) => (words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`);

const packOf = (data: PageData, name: string) => data.packs.find((pack) => pack.name === name);

function inPageOrder(data: PageData, names: Iterable<string>) {
  const wanted = new Set(names);
  return data.packs.map((pack) => pack.name).filter((name) => wanted.has(name));
}

export function toggleExtra(data: PageData, start: Start, name: string): Start {
  if (!data.extraPacks.includes(name)) return start;
  const extras = start.extras.includes(name) ? start.extras.filter((extra) => extra !== name) : [...start.extras, name];
  return { ...start, extras: inPageOrder(data, extras) };
}

export function setupSplit(data: PageData, start: Start) {
  const packs = inPageOrder(data, [...data.startPacks, ...start.extras, ...(start.where === "hub" ? data.hubStartPacks : [])]);
  const hubSide = [...data.needsHubPacks, ...data.prefersHubPacks];
  const waits = (name: string) => start.where === "hub" && hubSide.includes(name);
  return { first: packs.filter((name) => !waits(name)), later: hubSide.filter((name) => waits(name) && packs.includes(name)) };
}

export function startPrompt(data: PageData, start: Start) {
  const { first, later } = setupSplit(data, start);
  return [
    `Set up Fleet on this Mac with me. Read https://raw.githubusercontent.com/${data.engineRepo}/main/SETUP.md and follow it step by step.`,
    "",
    promptLabels.intro,
    `- ${promptLabels.where}: ${whereLabels[start.where]}`,
    `- ${promptLabels.firstPacks}: ${first.join(", ")}`,
    ...(start.where === "hub" ? [`- ${promptLabels.laterPacks}: ${later.join(", ")}`] : []),
  ].join("\n");
}

export function toggleSelected(data: PageData, selected: string[], name: string): string[] {
  const packs = new Set(selected);
  const drop = (target: string) => {
    packs.delete(target);
    for (const pack of data.packs) if (packs.has(pack.name) && pack.requires.includes(target)) drop(pack.name);
  };
  const add = (target: string) => {
    const pack = packOf(data, target);
    if (!pack || pack.always || packs.has(target)) return;
    packs.add(target);
    pack.requires.forEach(add);
  };
  if (packs.has(name)) drop(name);
  else add(name);
  return inPageOrder(data, packs);
}

export const installCommand = (selected: string[]) => `fleet packs ${selected.map((name) => `--add ${name}`).join(" ")}`;

function hubStep(data: PageData, titles: string[]) {
  const one = titles.length === 1;
  return `${one ? "This pack needs" : "These packs need"} a hub: ${listed(titles)}. Run \`fleet hub status\`. When it prints "The hub: not named", I have no hub yet. Tell me, leave ${one ? "that pack" : "those packs"} out, and offer to add a hub and a node first with step 9 of https://raw.githubusercontent.com/${data.engineRepo}/main/SETUP.md. Otherwise the name after "The hub:" is the SSH name of the hub. Use it as the host of each SSH command in a note.`;
}

function noteStep(notes: PagePack[]) {
  const source = notes.some((pack) => pack.setupNote!.includes("<source>")) ? ["   `<source>` is the folder in `~/.local/share/fleet/sources` that holds the pack."] : [];
  return [
    'Read the setup note of each pack, and follow it. Where a note names "the setup command" or "the command in step 9", use the `fleet packs` command of this prompt.',
    ...notes.map((pack) => `   - ${pack.title}: ${pack.setupNote}`),
    ...source,
  ].join("\n");
}

export function installPrompt(data: PageData, selected: string[]) {
  const packs = data.packs.filter((pack) => selected.includes(pack.name));
  if (!packs.length) return "";
  const notes = packs.filter((pack) => pack.setupNote);
  const onHub = packs.filter((pack) => data.needsHubPacks.includes(pack.name)).map((pack) => pack.title);
  const steps = [
    "Run `fleet update`, so this machine has the newest engine and packs. Then run `fleet packs`, and leave out each pack that is already on.",
    ...(notes.length ? [noteStep(notes)] : []),
    ...(onHub.length ? [hubStep(data, onHub)] : []),
    `Turn the packs on with one command, and add the flags that the notes name:\n   ${installCommand(packs.map((pack) => pack.name))}`,
    "Run `fleet doctor`, and explain each line. Do each `To do:` line with me, and say what a sign-in is for before it opens.",
    "My other machines take the change at their next `fleet update`. To give it to one now, run `fleet update` there, the hub first.",
  ];
  return [
    `Add ${packs.length === 1 ? "this Fleet pack" : "these Fleet packs"} to my setup with me: ${listed(packs.map((pack) => pack.title))}.`,
    "",
    "Fleet already runs on this machine. Ask me each choice with your question tool, and run every command yourself.",
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ].join("\n");
}
