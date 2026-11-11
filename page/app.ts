/// <reference lib="dom" />
import { installPrompt, startPrompt, toggleSelected, toggleStart, whereLabels, type PromptData, type Start, type Where } from "./model.ts";
import { promptHtml, t3Link } from "./prompt.ts";

const selectionKey = "fleet-packs";
const dataNode = document.getElementById("fleet-data");
const data: PromptData | undefined = dataNode ? JSON.parse(dataNode.textContent!) : undefined;

function storedSelection(): string[] {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(selectionKey) ?? "[]");
    return Array.isArray(stored) ? stored.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function storeSelection(selected: string[]) {
  try {
    sessionStorage.setItem(selectionKey, JSON.stringify(selected));
  } catch {}
}

function showPrompt(id: string, text: string, status: string) {
  const pre = document.getElementById(`${id}-text`)!;
  pre.innerHTML = promptHtml(text, pre.textContent!.split("\n"));
  (document.getElementById(`${id}-t3`) as HTMLAnchorElement).href = t3Link(text);
  document.getElementById(`${id}-status`)!.textContent = status;
}

function chooser(form: HTMLFormElement, data: PromptData) {
  const switchOf = (where: Where, pack: string) => form.elements.namedItem(`${where}:${pack}`) as HTMLInputElement;
  const radioOf = (where: Where) => form.querySelector<HTMLInputElement>(`#where-${where}`)!;
  const starts: Record<Where, Start> = { mac: { where: "mac", off: [] }, hub: { where: "hub", off: [] } };
  for (const where of ["mac", "hub"] as const) starts[where].off = data.startPacks.filter((pack) => !switchOf(where, pack).checked);
  let where: Where = radioOf("hub").checked ? "hub" : "mac";

  const show = () => {
    radioOf(where).checked = true;
    for (const start of Object.values(starts)) for (const pack of data.startPacks) switchOf(start.where, pack).checked = !start.off.includes(pack);
    showPrompt("start", startPrompt(data, starts[where]), `The prompt is for ${whereLabels[where]}.`);
  };

  form.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.name === "where") where = input.value as Where;
    else {
      const [box, pack] = input.name.split(":") as [Where, string];
      starts[box] = toggleStart(data, starts[box], pack);
      where = box;
    }
    show();
  });
  show();
}

function picker(form: HTMLFormElement, data: PromptData) {
  const boxes = [...form.querySelectorAll<HTMLInputElement>('input[name="pack"]')];
  const stored = () => storedSelection().reduce((picked, name) => (picked.includes(name) ? picked : toggleSelected(data, picked, name)), [] as string[]);
  let selected = stored();

  const show = () => {
    for (const box of boxes) box.checked = selected.includes(box.value);
    storeSelection(selected);
    document.getElementById("install-empty")!.hidden = selected.length > 0;
    document.getElementById("install-full")!.hidden = selected.length === 0;
    const count = selected.length === 1 ? "1 pack selected" : `${selected.length} packs selected`;
    document.getElementById("install-count")!.textContent = count;
    const jump = document.getElementById("install-jump")!;
    jump.hidden = selected.length === 0;
    jump.textContent = `${count}. See the prompt`;
    showPrompt("install", installPrompt(data, selected), count);
  };

  form.addEventListener("change", (event) => {
    selected = toggleSelected(data, selected, (event.target as HTMLInputElement).value);
    show();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    selected = stored();
    show();
  });
  show();
}

function copyButtons() {
  document.addEventListener("click", async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-copy]");
    if (!button) return;
    const label = button.textContent!;
    try {
      await navigator.clipboard.writeText(document.getElementById(button.dataset.copy!)!.textContent!);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select the text and copy it";
    }
    setTimeout(() => (button.textContent = label), 1600);
  });
}

function selectLinks() {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-select]"))
    link.addEventListener("click", () => storeSelection([...new Set([...storedSelection(), link.dataset.select!])]));
}

function linksFromDisk() {
  if (location.protocol !== "file:") return;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="."], a[href$="/"]:not([href*=":"])'))
    link.setAttribute("href", link.getAttribute("href")!.replace(/\/(#.*)?$/, "/index.html$1"));
}

const chooserForm = document.getElementById("chooser") as HTMLFormElement | null;
const pickerForm = document.getElementById("picker") as HTMLFormElement | null;
if (chooserForm && data) chooser(chooserForm, data);
if (pickerForm && data) picker(pickerForm, data);
copyButtons();
selectLinks();
linksFromDisk();
