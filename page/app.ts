/// <reference lib="dom" />
import type { PackSetting, SettingValue } from "../src/pack/types.ts";
import { parseSettingValue } from "../src/setup/flags.ts";
import {
  activePreset,
  activeSettings,
  commandText,
  missingPack,
  momentState,
  presetPicks,
  profileFile,
  questions,
  setSetting,
  settingAsks,
  setupAsks,
  togglePack,
  toggleWorkflow,
  type PageData,
  type PagePack,
  type PageWorkflow,
} from "./model.ts";

const data: PageData = JSON.parse(document.getElementById("fleet-data")!.textContent!);
let picks = presetPicks(data, data.defaultPreset);
let tab: "command" | "profile" = "command";
let opened = new Set<string>();

const esc = (text: unknown) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const fmt = (text: string) => esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
const packOf = (name: string) => data.packs.find((pack) => pack.name === name)!;
const flag = (name: string) => {
  const index = data.packs.findIndex((pack) => pack.name === name);
  return `<span class="flag flag-${index < 0 ? 7 : index % 8}" aria-hidden="true"></span>`;
};
const needs = (workflow: PageWorkflow, missing?: string) =>
  workflow.needs.length
    ? `<div class="needs">${workflow.needs.map((need) => `<span class="need ${missing && data.needPacks[need] === missing ? "miss" : ""}">needs ${esc(data.needLabels[need] ?? need)}</span>`).join("")}</div>`
    : "";

type Moment = { pack: PagePack; workflow: PageWorkflow; moment: NonNullable<PageWorkflow["moment"]> };
const moments: Moment[] = data.packs
  .flatMap((pack) => pack.workflows.map((workflow) => ({ pack, workflow, moment: workflow.moment! })))
  .filter((item) => item.moment)
  .sort((left, right) => left.moment.time.localeCompare(right.moment.time));

function presetLabel() {
  const preset = activePreset(data, picks);
  return preset ? `${esc(preset.name)} preset` : "Custom picks";
}

function packBar() {
  const preset = activePreset(data, picks);
  const presets = data.presets
    .map((item) => `<button class="chip" data-act="preset" data-id="${esc(item.id)}" aria-pressed="${preset?.id === item.id}" title="${esc(item.blurb)}">${esc(item.name)}</button>`)
    .join("");
  const packs = data.packs
    .map((pack) =>
      pack.always
        ? `<span class="chip" aria-disabled="true">${flag(pack.name)}${esc(pack.title)} · always</span>`
        : `<button class="chip" data-act="pack" data-id="${esc(pack.name)}" aria-pressed="${picks.packs.includes(pack.name)}">${flag(pack.name)}${esc(pack.title)}</button>`,
    )
    .join("");
  return `<div class="packbar" aria-label="Your picks">
    <div class="packbar-top"><div class="chips" role="group" aria-label="Presets">${presets}</div><span class="eyebrow" data-live="preset">${presetLabel()}</span></div>
    <div class="chips" role="group" aria-label="Packs">${packs}</div>
  </div>`;
}

function fixButton(item: Moment) {
  const state = momentState(data, picks, item.workflow, item.pack.name);
  if (state.on) return "";
  if ("workflow" in state.fix) return `<button data-act="wf" data-id="${esc(item.workflow.id)}">Turn on ${esc(item.workflow.name)}</button>`;
  const pack = packOf(state.fix.pack);
  const label = pack.name === item.pack.name ? `Add the ${esc(pack.title)} pack` : `Needs the ${esc(pack.title)} pack`;
  return `<button data-act="pack" data-id="${esc(pack.name)}">${label}</button>`;
}

function timeline() {
  const seen = new Set<string>();
  const row = (item: Moment) => {
    const on = momentState(data, picks, item.workflow, item.pack.name).on;
    const words = (item.moment.words ?? []).filter((word) => !seen.has(word)).map((word) => data.concepts.find((concept) => concept.word === word)).filter((concept) => !!concept);
    words.forEach((concept) => seen.add(concept.word));
    const needText = item.workflow.needs.map((need) => data.needLabels[need] ?? need).join(", ");
    const fix = fixButton(item);
    return `<article class="moment ${on ? "" : "off"} ${item.moment.night ? "night" : ""}" data-workflow="${esc(item.workflow.id)}">
      <div class="time">${esc(item.moment.time)}</div>
      <div style="min-width:0"><h3>${esc(item.moment.title)}</h3><p>${fmt(item.moment.body)}</p>
        <div class="tag">${flag(item.pack.name)}<span>${esc(item.pack.title)} · ${esc(item.workflow.name)}${needText ? ` · needs ${esc(needText)}` : ""}</span></div>
        ${fix ? `<div class="get">${fix}</div>` : ""}
        ${item.workflow.risk ? `<div class="warnbox">${fmt(item.workflow.risk)}</div>` : ""}
      </div>
      <div class="notes">${words.map((concept) => `<div class="note"><span class="eyebrow">New word</span><b>${esc(concept.word)}</b><span>${fmt(concept.note)}</span></div>`).join("")}</div>
    </article>`;
  };
  return `<div class="line">
    <div class="divider eyebrow">Daytime</div>
    ${moments.filter((item) => !item.moment.night).map(row).join("")}
    <div class="divider eyebrow">While you sleep</div>
    ${moments.filter((item) => item.moment.night).map(row).join("")}
  </div>`;
}

function workflowRows(pack: PagePack) {
  return pack.workflows
    .map((workflow) => {
      const state = momentState(data, picks, workflow, pack.name);
      const needed = !state.on && "pack" in state.fix ? packOf(state.fix.pack) : undefined;
      return `<div class="wf ${state.on ? "" : "wf-off"}">
        <button class="switch" role="switch" aria-label="${esc(workflow.name)}" aria-checked="${state.on}" data-act="wf" data-id="${esc(workflow.id)}" ${needed ? "disabled" : ""}></button>
        <div class="wf-body"><div class="wf-name">${esc(workflow.name)}${workflow.default ? "" : ' <span class="badge">off by default</span>'}</div>
          <div class="wf-sentence">${fmt(workflow.sentence)}</div>
          ${needs(workflow, missingPack(data, picks, workflow))}
          ${needed && !missingPack(data, picks, workflow) ? `<div class="muted" style="font-size:.85rem;margin-top:4px">Needs the ${esc(needed.title)} pack.</div>` : ""}
        </div></div>`;
    })
    .join("");
}

const shownValue = (setting: PackSetting) => picks.settings[setting.key] ?? setting.default;

function control(setting: PackSetting, id: string) {
  const value = shownValue(setting);
  if (setting.type === "choice" || setting.type === "boolean") {
    const choices = setting.type === "boolean" ? [{ value: true, label: "On" }, { value: false, label: "Off" }] : (setting.choices ?? []);
    const blank = value === undefined ? `<option value="" selected>Setup asks</option>` : "";
    return `<select id="${id}" data-key="${esc(setting.key)}">${blank}${choices.map((choice) => `<option value="${esc(choice.value)}" ${choice.value === value ? "selected" : ""}>${esc(choice.label)}</option>`).join("")}</select>`;
  }
  return `<input id="${id}" data-key="${esc(setting.key)}" type="${setting.type === "number" ? "number" : "text"}" value="${esc(value ?? "")}" placeholder="${setting.optional ? "Optional" : "Setup asks"}">`;
}

function markFor(setting: PackSetting, open = questions(data, picks)) {
  const value = picks.settings[setting.key];
  if (value !== undefined && value !== setting.default) return '<span class="mark changed">changed</span>';
  const asks = settingAsks(open, setting);
  return asks ? `<span class="mark">· ${asks}</span>` : "";
}

function settingsBlock(pack: PagePack) {
  const shown = activeSettings(data, picks, pack);
  if (!shown.length) return "";
  const open = questions(data, picks);
  return `<div class="settings">${shown
    .map((setting) => {
      const id = `s-${setting.key.replace(/\W/g, "-")}`;
      return `<div class="setting"><label for="${id}">${esc(setting.question)} <span data-mark="${esc(setting.key)}">${markFor(setting, open)}</span></label>${control(setting, id)}</div>`;
    })
    .join("")}</div>`;
}

function refreshMarks() {
  const open = questions(data, picks);
  const settings = data.packs.flatMap((pack) => pack.settings);
  for (const slot of document.querySelectorAll<HTMLElement>("[data-mark]")) {
    const setting = settings.find((item) => item.key === slot.dataset.mark);
    if (setting) slot.innerHTML = markFor(setting, open);
  }
}

function tune() {
  return `<div class="tune"><h2>Tune it</h2>
    ${data.packs
      .map((pack) => {
        const on = pack.always || picks.packs.includes(pack.name);
        const state = pack.always ? '<span class="badge">always</span>' : on ? "" : '<span class="badge">off</span>';
        const add = on ? "" : `<div class="get"><button data-act="pack" data-id="${esc(pack.name)}">Add the ${esc(pack.title)} pack</button></div>`;
        return `<details data-pack="${esc(pack.name)}" ${opened.has(pack.name) ? "open" : ""}><summary>${flag(pack.name)} ${esc(pack.title)} ${state}</summary>
        <div class="facts"><p>${fmt(pack.day ?? pack.summary)}</p>${pack.cost ? `<p class="muted">${fmt(pack.cost)}</p>` : ""}${pack.risk ? `<div class="warnbox">${fmt(pack.risk)}</div>` : ""}${add}</div>
        ${workflowRows(pack)}${on ? settingsBlock(pack) : ""}</details>`;
      })
      .join("")}
    <div class="aud">${flag(data.teamPacks[0] ?? "")}<span>${esc(data.teamNote)}</span></div>
    <details data-pack="machines" ${opened.has("machines") ? "open" : ""}><summary>How the machines fit together</summary>${diagram()}</details>
  </div>`;
}

function output() {
  const text = tab === "command" ? commandText(data, picks) : JSON.stringify(profileFile(data, picks), null, 2);
  const note =
    tab === "command"
      ? `Run it in a terminal on your Mac. Setup keeps these picks with one key press, signs you in, and ${setupAsks(data, picks)}.`
      : "Setup saves these picks to <code>fleet.json</code> in your private <code>fleet-profile</code> repo. Every machine you set up reads it.";
  return `<div class="out" id="out">
    <div class="out-tabs" role="tablist">
      <button class="out-tab" role="tab" data-act="tab" data-id="command" aria-selected="${tab === "command"}">One command</button>
      <button class="out-tab" role="tab" data-act="tab" data-id="profile" aria-selected="${tab === "profile"}">fleet.json</button>
    </div>
    <pre id="out-text">${esc(text)}</pre>
    <div class="out-foot"><span class="out-note" data-live="questions">${note}</span><button data-act="copy">Copy</button></div>
  </div>`;
}

function diagram() {
  return `<div class="diagram" role="img" aria-label="Your Mac runs the T3 Code app and links to a devbox, where agents run threads in worktrees. An optional hub shares your MCP servers and watches disks.">
  <svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg">
    <rect class="d-node" x="10" y="30" width="200" height="130" rx="12"/>
    <text class="d-txt" x="28" y="58">Your Mac</text>
    <rect class="d-sub" x="28" y="72" width="164" height="34" rx="6"/><text class="d-mono" x="40" y="94">T3 Code app</text>
    <text class="d-small" x="28" y="130">You read and reply here,</text><text class="d-small" x="28" y="146">or on your phone.</text>
    <path class="d-link" d="M210 95 H300"/><text class="d-lbl" x="222" y="85">linked</text>
    <rect class="d-node" x="300" y="12" width="250" height="170" rx="12"/>
    <text class="d-txt" x="318" y="40">Your devbox</text>
    <rect class="d-sub" x="318" y="54" width="214" height="28" rx="6"/><text class="d-mono" x="330" y="73">thread · worktree fix-login</text>
    <rect class="d-sub" x="318" y="88" width="214" height="28" rx="6"/><text class="d-mono" x="330" y="107">thread · worktree new-chart</text>
    <rect class="d-sub" x="318" y="122" width="214" height="28" rx="6"/><text class="d-mono" x="330" y="141">thread · worktree docs</text>
    <text class="d-small" x="318" y="170">Agents use skills from your packs.</text>
    <path class="d-optlink" d="M425 182 V222"/>
    <rect class="d-opt" x="300" y="222" width="250" height="68" rx="12"/>
    <text class="d-txt" x="318" y="248">Hub (optional)</text>
    <text class="d-small" x="318" y="268">An always-on devbox that shares</text><text class="d-small" x="318" y="283">MCP servers with the others.</text>
    <path class="d-optlink" d="M550 256 H600"/>
    <rect class="d-opt" x="600" y="214" width="150" height="40" rx="8"/><text class="d-mono" x="614" y="239">MCP gateway</text>
    <rect class="d-opt" x="600" y="260" width="150" height="34" rx="8"/><text class="d-mono" x="614" y="282">disk watch</text>
    <text class="d-small" x="580" y="40">Each machine signs in</text><text class="d-small" x="580" y="56">to Claude and Codex itself.</text>
    <text class="d-small" x="580" y="72">No hub needed.</text>
  </svg></div>`;
}

const attr = (name: string, value: string | undefined) => (value === undefined ? "" : `[${name}="${CSS.escape(value)}"]`);

function focusTarget() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.dataset.act) return [];
  const { act, id } = active.dataset;
  const pack = active.closest<HTMLElement>("details[data-pack]");
  const moment = active.closest<HTMLElement>("article[data-workflow]");
  const scope = pack ? `details${attr("data-pack", pack.dataset.pack)}` : moment ? `article${attr("data-workflow", moment.dataset.workflow)}` : active.closest(".packbar") ? ".packbar" : active.closest("#out") ? "#out" : "";
  const control = `${attr("data-act", act)}${attr("data-id", id)}`;
  const owner = data.packs.find((item) => item.workflows.some((workflow) => workflow.id === id))?.name;
  const steady = act === "pack" ? [`.packbar ${control}`] : act === "wf" ? [`details[data-pack] ${control}`, `details${attr("data-pack", owner)} > summary`] : [];
  return [`${scope} ${control}`, ...steady];
}

function restoreFocus(targets: string[]) {
  for (const target of targets) {
    document.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
    if (document.activeElement?.matches(target)) return;
  }
}

function render() {
  const focus = focusTarget();
  const top = window.scrollY;
  opened = new Set([...document.querySelectorAll<HTMLDetailsElement>("details[data-pack][open]")].map((details) => details.dataset.pack!));
  document.getElementById("app")!.innerHTML = `<div class="wrap">
    <header class="hero"><span class="eyebrow">Fleet · agent workflows</span>
      <h1>A day with Fleet</h1>
      <p class="prose muted">Here is a workday with agents doing the busywork. Turn packs on and off, and watch which parts of the day you keep. Faded moments need a pack or a workflow you have not picked.</p>
    </header>
    ${packBar()}
    ${timeline()}
    <section class="finish">${tune()}<div class="get-col"><h2>Get it</h2>${output()}</div></section>
  </div>`;
  window.scrollTo(0, top);
  restoreFocus(focus);
}

function refreshOutput() {
  const focus = focusTarget();
  const out = document.getElementById("out");
  if (out) out.outerHTML = output();
  restoreFocus(focus);
}

function copy(button: HTMLElement) {
  const text = document.getElementById("out-text")!;
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    button.textContent = "Selected: press Ctrl-C or ⌘C";
  };
  if (!navigator.clipboard) return select();
  navigator.clipboard.writeText(text.textContent ?? "").then(() => (button.textContent = "Copied"), select);
}

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!target || (target as HTMLButtonElement).disabled) return;
  const { act, id = "" } = target.dataset;
  if (act === "copy") return copy(target);
  if (act === "tab") {
    tab = id === "profile" ? "profile" : "command";
    return refreshOutput();
  }
  if (act === "preset") picks = presetPicks(data, id, picks.settings);
  if (act === "pack") picks = togglePack(data, picks, id);
  if (act === "wf") picks = toggleWorkflow(data, picks, id);
  render();
});

function onSetting(event: Event, committed: boolean) {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  const key = input.dataset?.key;
  const setting = key && data.packs.flatMap((pack) => pack.settings).find((item) => item.key === key);
  if (!setting) return;
  const text = input.value.trim();
  let value: SettingValue | undefined;
  try {
    value = text === "" ? undefined : parseSettingValue(setting, text);
  } catch (error) {
    input.setAttribute("aria-invalid", "true");
    input.title = (error as Error).message;
    return;
  }
  input.removeAttribute("aria-invalid");
  input.removeAttribute("title");
  picks = setSetting(data, picks, setting.key, value);
  if (committed && input instanceof HTMLInputElement) input.value = value === undefined ? "" : String(value);
  refreshMarks();
  refreshOutput();
}
document.addEventListener("input", (event) => onSetting(event, false));
document.addEventListener("change", (event) => onSetting(event, true));

render();
