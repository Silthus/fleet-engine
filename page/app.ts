/// <reference lib="dom" />
import type { PackSetting, SettingValue } from "../src/pack/types.ts";
import { parseSettingValue } from "../src/setup/flags.ts";
import { packFlows } from "./flows.ts";
import { brandIcons, packIcon, uiIcons } from "./icons.ts";
import { logoMark } from "./logo.ts";
import {
  activePreset,
  activeSettings,
  chosen,
  commandText,
  runState,
  missingPack,
  presetPicks,
  profileFile,
  promptText,
  questions,
  setSetting,
  settingAsks,
  setupAsks,
  setupSplit,
  setWhere,
  togglePack,
  toggleWorkflow,
  waitsForHub,
  whereLabels,
  workflowOf,
  type PageData,
  type PagePack,
  type PageWorkflow,
  type Where,
} from "./model.ts";

const data: PageData = JSON.parse(document.getElementById("fleet-data")!.textContent!);
let picks = presetPicks(data, data.defaultPreset);
let tab: "command" | "profile" = "command";
let opened = new Set<string>();
type SheetTab = "overview" | "workflows" | "settings";
let openPack: string | undefined;
let sheetTab: SheetTab = "overview";
const sheet = document.getElementById("pack-sheet") as HTMLDialogElement;

const esc = (text: unknown) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const fmt = (text: string) => esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const listed = (words: string[]) => (words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`);
const packOf = (name: string) => data.packs.find((pack) => pack.name === name)!;
const packOn = (pack: PagePack) => pack.always || picks.packs.includes(pack.name);
const needsHub = (pack: PagePack) => data.needsHubPacks.includes(pack.name);
const iconTile = (name: string, size = "") => `<span class="icon ${size} ${brandIcons.has(name) ? "brand" : ""}">${packIcon(name)}</span>`;
const open = (key: string) => `data-open="${esc(key)}" ${opened.has(key) ? "open" : ""}`;

const hubButton = (focus: string, fallback: string) => `<button class="btn-line" data-act="where" data-id="hub" data-focus="${esc(focus)}" data-fallback="${esc(fallback)}">Add a hub and a node</button>`;

function hero() {
  return `<header class="hero"><div class="wrap hero-in">
    <p class="brand">${logoMark}<span>Fleet</span></p>
    <h1>Set up your coding agents once. Every machine gets the same setup.</h1>
    <div class="pitch">
      <div><p class="eyebrow">The problem</p><p>Coding agents get much better with good rules, skills, and a machine that stays on. Setting that up by hand takes a day for each machine, and the machines drift apart.</p></div>
      <div><p class="eyebrow">What Fleet does</p><p>Fleet sets up T3 Code, Claude Code, Codex, and a set of agent workflows on your Mac and your Linux devboxes. You pick the workflows as <b>packs</b>. Your answers live in your own private <b>profile</b> repo, so every machine gets the same setup.</p></div>
    </div>
    <figure class="overview"><img src="${data.overview.image}" alt="${esc(data.overview.alt)}" width="760" height="330"></figure>
    <nav class="route" aria-label="On this page"><a href="#where"><b>1</b>Choose where it runs</a><a href="#packs"><b>2</b>Choose your packs</a><a class="go" href="#start"><b>3</b>Get started</a></nav>
  </div></header>`;
}

const stepHead = (number: number, id: string, title: string, sub: string) =>
  `<header class="step-head"><span class="step-n" aria-hidden="true">${number}</span><div><h2 id="${id}-h">${title}</h2><p class="muted prose">${sub}</p></div></header>`;

function whereDiagram(where: Where) {
  const remote = where === "hub" ? "d-node" : "d-ghost";
  const text = where === "hub" ? "" : " d-faint";
  return `<svg class="where-map" viewBox="0 0 320 96" aria-hidden="true">
    <rect class="d-zone" x="112" y="4" width="204" height="88" rx="12"/>
    <text class="d-zone-t" x="214" y="19" text-anchor="middle">${where === "hub" ? "always on, in the cloud" : "add later, when you want"}</text>
    <rect class="d-node" x="4" y="30" width="88" height="52" rx="9"/><text class="d-txt" x="48" y="52" text-anchor="middle">Your Mac</text><text class="d-small" x="48" y="68" text-anchor="middle">T3 Code</text>
    <path class="${where === "hub" ? "d-link" : "d-nolink"}" d="M92 56H122"/>
    <rect class="${remote}" x="122" y="30" width="84" height="52" rx="9"/><text class="d-txt${text}" x="164" y="52" text-anchor="middle">Hub</text><text class="d-small${text}" x="164" y="68" text-anchor="middle">200 GB disk</text>
    <path class="${where === "hub" ? "d-link" : "d-nolink"}" d="M206 56H224"/>
    <rect class="${remote}" x="224" y="30" width="84" height="52" rx="9"/><text class="d-txt${text}" x="266" y="52" text-anchor="middle">Node</text><text class="d-small${text}" x="266" y="68" text-anchor="middle">500 GB disk</text>
  </svg>`;
}

function whereCard(where: Where) {
  const on = picks.where === where;
  const hubTitles = data.needsHubPacks.map((name) => packOf(name).title);
  const facts =
    where === "mac"
      ? ["Your Mac gets every pack's skills and rules, and each workflow that a Mac can run.", "Agents stop when the Mac sleeps.", "Workflows that need a machine that stays on, such as the nightly loops, wait until you add a node."]
      : [
          "Two Linux devboxes in the cloud stay on while the Mac sleeps.",
          "The node is where threads do the work. The hub links your machines and watches their disks.",
          ...(hubTitles.length ? [`You can turn on ${plural(hubTitles.length, "more pack")}, ${listed(hubTitles)}.`] : []),
          "Add more nodes later, when the load grows.",
        ];
  return `<div class="where ${on ? "on" : ""}" data-act="where" data-id="${where}">
    <div class="where-top"><input type="radio" name="where" id="where-${where}" value="${where}" data-focus="where:${where}" ${on ? "checked" : ""}><label for="where-${where}">${whereLabels[where]}</label><span class="badge">${where === "mac" ? "Simplest start" : "Agents work overnight"}</span></div>
    ${whereDiagram(where)}
    <ul>${facts.map((fact) => `<li>${esc(fact)}</li>`).join("")}</ul>
  </div>`;
}

function whereSection() {
  return `<section id="where" class="step" aria-labelledby="where-h">
    ${stepHead(1, "where", "Where should your agents run?", "Start on your Mac. A hub and a node keep agents working while the Mac sleeps. You can add them later.")}
    <fieldset class="wheres"><legend class="sr">Where Fleet runs</legend>${whereCard("mac")}${whereCard("hub")}</fieldset>
  </section>`;
}

function presetCards() {
  const active = activePreset(data, picks);
  const cards = data.presets
    .map((preset) => {
      const names = [...new Set([...preset.packs, ...data.teamPacks, ...(picks.where === "hub" ? preset.hubPacks : [])])];
      const minis = data.packs.filter((pack) => pack.always || names.includes(pack.name)).map((pack) => iconTile(pack.name, "mini")).join("");
      return `<button class="preset" data-act="preset" data-id="${esc(preset.id)}" data-focus="preset:${esc(preset.id)}" aria-pressed="${active?.id === preset.id}">
        <span class="preset-name">${esc(preset.name)}</span><span class="preset-blurb">${esc(preset.blurb)}</span>
        <span class="preset-icons" aria-hidden="true">${minis}</span><span class="preset-count">Base and ${plural(names.length, "pack")}</span>
      </button>`;
    })
    .join("");
  return `<div class="presets" role="group" aria-label="Presets">${cards}</div>
    <p class="preset-state muted" data-live="preset">${active ? `You are on the ${esc(active.name)} preset. Turn any pack on or off below.` : "These are your own picks. Choose a preset to start again from it."}</p>`;
}

function needChips(pack: PagePack, workflow: PageWorkflow) {
  const live = packOn(pack) && chosen(picks, workflow);
  const unmet = (need: PageWorkflow["needs"][number]) => live && (missingPack(data, picks, { ...workflow, needs: [need] }) !== undefined || waitsForHub(picks, { ...workflow, needs: [need] }));
  return workflow.needs
    .filter((need) => data.needPacks[need] !== pack.name)
    .map((need) => `<span class="need ${unmet(need) ? "miss" : ""}">needs ${esc(data.needLabels[need] ?? need)}</span>`)
    .join("");
}

function workflowRows(pack: PagePack) {
  return pack.workflows
    .map((workflow) => {
      const state = runState(data, picks, workflow);
      const blocked = !packOn(pack) || missingPack(data, picks, workflow) !== undefined;
      const requires = !state.on && "workflow" in state.fix && state.fix.workflow !== workflow.id ? workflowOf(data, state.fix.workflow) : undefined;
      const chips = `${workflow.default ? "" : '<span class="need">off by default</span>'}${needChips(pack, workflow)}`;
      return `<div class="wf ${state.on ? "" : "wf-off"}">
        <button class="switch small" role="switch" aria-label="${esc(workflow.name)}" aria-checked="${chosen(picks, workflow)}" data-act="wf" data-id="${esc(workflow.id)}" data-focus="wf:${esc(workflow.id)}" ${blocked ? "disabled" : ""}></button>
        <div class="wf-body"><div class="wf-name">${esc(workflow.name)}</div>
          <div class="wf-sentence">${fmt(workflow.sentence)}</div>
          ${chips ? `<div class="needs">${chips}</div>` : ""}
          ${requires ? `<div class="wf-hint">Turn on ${esc(requires.name)} first.</div>` : ""}
          ${workflow.risk ? `<details class="sub risk" ${open(`risk:${workflow.id}`)}><summary>Read before you turn it on</summary><p class="warn">${fmt(workflow.risk)}</p></details>` : ""}
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
    return `<select id="${id}" data-key="${esc(setting.key)}" data-focus="${id}">${blank}${choices.map((choice) => `<option value="${esc(choice.value)}" ${choice.value === value ? "selected" : ""}>${esc(choice.label)}</option>`).join("")}</select>`;
  }
  return `<input id="${id}" data-key="${esc(setting.key)}" data-focus="${id}" type="${setting.type === "number" ? "number" : "text"}" value="${esc(value ?? "")}" placeholder="${setting.optional ? "Optional" : "Setup asks"}">`;
}

function markFor(setting: PackSetting, asks = questions(data, picks)) {
  const value = picks.settings[setting.key];
  if (value !== undefined && value !== setting.default) return '<span class="mark changed">changed</span>';
  const note = settingAsks(asks, setting);
  return note ? `<span class="mark">${note}</span>` : "";
}

function settingsBlock(pack: PagePack) {
  const shown = activeSettings(data, picks, pack);
  if (!shown.length) return "";
  const asks = questions(data, picks);
  const fields = shown
    .map((setting) => {
      const id = `s-${setting.key.replace(/\W/g, "-")}`;
      return `<div class="setting"><label for="${id}">${esc(setting.question)} <span data-mark="${esc(setting.key)}">${markFor(setting, asks)}</span></label>${control(setting, id)}</div>`;
    })
    .join("");
  return `<p class="muted">Each setting has a default, or setup asks you for it.</p><div class="settings">${fields}</div>`;
}

function refreshMarks() {
  const asks = questions(data, picks);
  const settings = data.packs.flatMap((pack) => pack.settings);
  for (const slot of document.querySelectorAll<HTMLElement>("[data-mark]")) {
    const setting = settings.find((item) => item.key === slot.dataset.mark);
    if (setting) slot.innerHTML = markFor(setting, asks);
  }
}

function packStatus(pack: PagePack) {
  if (pack.always) return "Always on";
  if (!packOn(pack)) return "Off";
  const live = pack.workflows.filter((workflow) => runState(data, picks, workflow).on).length;
  return live ? `On, with ${live} of ${plural(pack.workflows.length, "workflow")}` : "On, with no workflow yet";
}

function packCard(pack: PagePack) {
  const on = packOn(pack);
  const locked = needsHub(pack) && picks.where === "mac";
  const control = pack.always
    ? '<span class="badge">Always on</span>'
    : `<button class="switch" role="switch" aria-label="${esc(pack.title)} pack" aria-checked="${on}" data-act="pack" data-id="${esc(pack.name)}" data-focus="pack:${esc(pack.name)}" ${locked ? "disabled" : ""}></button>`;
  return `<article class="pack ${on ? "on" : ""} ${locked ? "locked" : ""}">
    <button class="pack-open" data-act="open" data-id="${esc(pack.name)}" data-focus="open:${esc(pack.name)}" aria-haspopup="dialog">
      ${iconTile(pack.name)}<span class="pack-name">${esc(pack.title)}${uiIcons.arrow}</span><span class="pack-sum">${fmt(pack.summary)}</span>
    </button>
    <div class="pack-ctl">${control}</div>
  </article>`;
}

const flowFigure = (steps: string[]) => `<ol class="flow">${steps.map((step) => `<li><span class="flow-step">${esc(step)}</span></li>`).join("")}</ol>`;

function sheetOverview(pack: PagePack, locked: boolean) {
  const flow = packFlows[pack.name];
  const live = pack.workflows.filter((workflow) => runState(data, picks, workflow).on).length;
  const needs = [...new Set(pack.workflows.flatMap((workflow) => workflow.needs))].filter((need) => data.needPacks[need] !== pack.name).map((need) => data.needLabels[need] ?? need);
  const required = pack.requires.map((name) => packOf(name)?.title).filter(Boolean).map((title) => `the ${title} pack`);
  const asks = listed([...needs, ...required]);
  return `<p class="sheet-lede">${fmt(pack.summary)}</p>
    ${flow ? flowFigure(flow) : pack.name === data.needPacks.hub ? `<div class="flow">${whereDiagram("hub")}</div>` : ""}
    ${pack.day ? `<div class="example"><p class="eyebrow">For example</p><p>${fmt(pack.day)}</p></div>` : ""}
    ${locked ? `<div class="example"><p>This pack runs on a hub. Add a hub and a node to turn it on.</p>${hubButton("sheet:unlock", `sheet:pack:${pack.name}`)}</div>` : ""}
    <div class="facts">
      <div class="fact"><p class="eyebrow">Workflows</p><p class="fact-big">${packOn(pack) ? `${live} of ${pack.workflows.length} on` : pack.workflows.length}</p><button class="link" data-act="sheet-tab" data-id="workflows" data-focus="sheet:see">See the workflows</button></div>
      <div class="fact"><p class="eyebrow">Needs</p><p>${asks ? esc(asks[0]!.toUpperCase() + asks.slice(1)) : "Nothing extra"}</p></div>
      ${pack.cost ? `<div class="fact"><p class="eyebrow">Cost</p><p>${fmt(pack.cost)}</p></div>` : ""}
    </div>
    ${pack.risk ? `<div class="warn"><p class="eyebrow">Know before you turn it on</p><p>${fmt(pack.risk)}</p></div>` : ""}`;
}

function sheetSettings(pack: PagePack) {
  if (!packOn(pack)) return '<p class="muted">Turn the pack on to change its settings.</p>';
  return settingsBlock(pack) || '<p class="muted">The workflows that are on have no settings.</p>';
}

function packSheet(pack: PagePack) {
  const on = packOn(pack);
  const locked = needsHub(pack) && picks.where === "mac";
  const control =
    pack.always || locked
      ? ""
      : `<button class="switch" role="switch" aria-label="${esc(pack.title)} pack" aria-checked="${on}" data-act="pack" data-id="${esc(pack.name)}" data-focus="sheet:pack:${esc(pack.name)}"></button>`;
  const tabs: Array<[SheetTab, string]> = [["overview", "Overview"], ["workflows", `Workflows (${pack.workflows.length})`], ...(pack.settings.length ? [["settings", `Settings (${on ? activeSettings(data, picks, pack).length : pack.settings.length})`] as [SheetTab, string]] : [])];
  const tab = tabs.some(([id]) => id === sheetTab) ? sheetTab : "overview";
  const hint = on || locked ? "" : '<p class="muted">Turn the pack on to choose its workflows.</p>';
  const panel = tab === "overview" ? sheetOverview(pack, locked) : tab === "workflows" ? `${hint}<div class="wfs">${workflowRows(pack)}</div>` : sheetSettings(pack);
  return `<header class="sheet-head">
      ${iconTile(pack.name, "big")}
      <div class="sheet-title"><h2 id="sheet-title">${esc(pack.title)}</h2><p class="status">${packStatus(pack)}</p></div>
      ${control}
      <button class="sheet-x" data-act="close" data-focus="sheet:close" aria-label="Close">${uiIcons.close}</button>
    </header>
    <div class="sheet-tabs" role="tablist" aria-label="${esc(pack.title)} pack">${tabs.map(([id, label]) => `<button role="tab" id="tab-${id}" aria-selected="${id === tab}" aria-controls="sheet-panel" tabindex="${id === tab ? 0 : -1}" data-act="sheet-tab" data-id="${id}" data-focus="sheet:tab:${id}">${label}</button>`).join("")}</div>
    <div class="sheet-body" id="sheet-panel" role="tabpanel" aria-labelledby="tab-${tab}">${panel}</div>`;
}

function showSheet(keepScroll: boolean) {
  const scrolled = keepScroll ? (sheet.querySelector(".sheet-body")?.scrollTop ?? 0) : 0;
  sheet.innerHTML = packSheet(packOf(openPack!));
  sheet.querySelector(".sheet-body")!.scrollTop = scrolled;
}

function packsSection() {
  const anywhere = data.packs.filter((pack) => !needsHub(pack));
  const onHub = data.packs.filter(needsHub);
  const hubHead =
    picks.where === "mac"
      ? `<p class="muted">These packs run on a hub.</p>${hubButton("unlock", `pack:${onHub[0]?.name ?? ""}`)}`
      : '<p class="muted">These packs run on your hub. The agent turns them on after it sets up the hub.</p>';
  return `<section id="packs" class="step" aria-labelledby="packs-h">
    ${stepHead(2, "packs", "Which packs do you want?", "A pack is a set of workflows that you turn on as a whole. Start from a preset, then turn packs on or off. Select a pack to read what it does.")}
    ${presetCards()}
    <div class="group-head"><h3>On any machine</h3></div>
    <div class="packs">${anywhere.map(packCard).join("")}</div>
    ${onHub.length ? `<div class="group-head"><h3>With a hub</h3>${hubHead}</div><div class="packs">${onHub.map(packCard).join("")}</div>` : ""}
    <p class="aud">${iconTile(data.teamPacks[0] ?? "", "mini")}<span>${esc(data.teamNote)}</span></p>
  </section>`;
}

function promptPicks() {
  const { first, later } = setupSplit(data, picks);
  const parts = [whereLabels[picks.where], `Base and ${plural(first.length, "pack")} on the first setup`, ...(picks.where === "hub" ? [`${plural(later.length, "pack")} once the hub runs`] : [])];
  return parts.join(", ");
}

function agentSteps() {
  const asks = questions(data, picks);
  const steps = [
    "It asks what you already know, and explains only the rest.",
    "It installs what is missing on your Mac: the GitHub CLI, Bun, the `t3` command, and Fleet.",
    "You sign in to GitHub, and to Claude, ChatGPT, or both. Each sign-in opens in your browser.",
    `It asks which AI plan you use${asks.settings.length ? `, and ${plural(asks.settings.length, "more question")} that your packs need` : ""}.`,
    "It saves your picks to `fleet-profile`, a private repo in your GitHub account, so every machine you add gets the same setup.",
    ...(picks.where === "hub" ? ["It creates the hub and the node with you, installs Fleet on both, and links them to your Mac."] : []),
    "It ends with `fleet doctor`, which checks each machine against your profile.",
  ];
  return `<ol class="agent-steps">${steps.map((step) => `<li>${fmt(step)}</li>`).join("")}</ol>`;
}

function byHand() {
  const text = tab === "command" ? commandText(data, picks) : JSON.stringify(profileFile(data, picks), null, 2);
  const later = picks.where === "hub" ? ` It sets up this Mac. Then add the hub and the node with <code>fleet devbox add</code>, as <a href="https://github.com/${esc(data.engineRepo)}/blob/main/docs/getting-started.md" target="_blank" rel="noopener">Getting started</a> shows.` : "";
  const note =
    tab === "command"
      ? `Run it in a terminal on your Mac. Setup keeps these picks with one key press, signs you in, and ${esc(setupAsks(data, picks))}.${later}`
      : "Setup saves these picks to <code>fleet.json</code> in your private <code>fleet-profile</code> repo. Every machine you set up reads it.";
  return `<div class="out">
    <div class="out-tabs" role="tablist">
      <button class="out-tab" role="tab" data-act="tab" data-id="command" data-focus="tab:command" aria-selected="${tab === "command"}">One command</button>
      <button class="out-tab" role="tab" data-act="tab" data-id="profile" data-focus="tab:profile" aria-selected="${tab === "profile"}">fleet.json</button>
    </div>
    <pre id="hand-text">${esc(text)}</pre>
    <div class="out-foot"><span class="out-note">${note}</span><button class="btn-solid" data-act="copy" data-id="hand-text" data-focus="copy:hand">Copy</button></div>
  </div>`;
}

function startOut() {
  const prompt = promptText(data, picks);
  return `<div class="out prompt">
      <div class="out-head"><span class="out-title">Your prompt</span><span class="out-picks" data-live="picks">${esc(promptPicks())}</span></div>
      <pre id="prompt-text">${esc(prompt)}</pre>
      <div class="out-foot"><button class="btn-solid" data-act="copy" data-id="prompt-text" data-focus="copy:prompt">Copy prompt</button><a class="btn-ghost" data-focus="open:t3" href="https://app.t3.codes/new?prompt=${encodeURIComponent(prompt)}" target="_blank" rel="noopener">Open in T3 Code${uiIcons.arrow}</a></div>
    </div>
    <p class="prose">The agent explains each part and runs the steps itself. You answer its questions and do your own sign-ins.</p>
    <details class="sub" ${open("start:agent")}><summary>What the agent does with you</summary>${agentSteps()}</details>
    <details class="sub" ${open("start:hand")}><summary>Set it up by hand</summary>${byHand()}</details>`;
}

function startSection() {
  return `<section id="start" class="step" aria-labelledby="start-h">
    ${stepHead(3, "start", "Get started", "There are three steps. In the last one, an agent takes over and sets up Fleet with you.")}
    <ol class="steps">
      <li><h3>Download T3 Code</h3><p>Get <a href="https://t3.codes" target="_blank" rel="noopener">T3 Code</a> and open it. Its Welcome page sets up one agent, Claude Code or Codex, and signs you in.</p></li>
      <li><h3>Sign in with T3 Connect</h3><p>In T3 Code, open <b>Settings → Sharing &amp; access</b>, sign in, and turn on <b>T3 Connect</b>. It links your Mac to your devboxes and your phone.</p></li>
      <li><h3>Paste this prompt</h3><p>Paste it into a new thread in T3 Code on your Mac. It carries your picks from this page, so the agent skips those questions.</p><div id="start-out">${startOut()}</div></li>
    </ol>
  </section>`;
}

function footer() {
  return `<footer class="foot"><div class="wrap"><p>Fleet is open source. Read the code and the docs at <a href="https://github.com/${esc(data.engineRepo)}" target="_blank" rel="noopener">github.com/${esc(data.engineRepo)}</a>.</p></div></footer>`;
}

const focusOf = () => {
  const active = document.activeElement;
  return active instanceof HTMLElement ? [active.dataset.focus, active.dataset.fallback] : [];
};

function restoreFocus(keys: Array<string | undefined>) {
  for (const key of keys) {
    const target = key ? document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`) : null;
    if (!target || (target as HTMLButtonElement).disabled) continue;
    target.focus({ preventScroll: true });
    return;
  }
}

const rememberOpened = () => (opened = new Set([...document.querySelectorAll<HTMLDetailsElement>("details[data-open][open]")].map((details) => details.dataset.open!)));

function render() {
  const focus = focusOf();
  const top = window.scrollY;
  rememberOpened();
  document.getElementById("app")!.innerHTML = `${hero()}<main class="wrap">${whereSection()}${packsSection()}${startSection()}</main>${footer()}`;
  window.scrollTo(0, top);
  if (openPack) showSheet(true);
  restoreFocus(focus);
}

function refreshOutputs() {
  const focus = focusOf();
  rememberOpened();
  const out = document.getElementById("start-out");
  if (out) out.innerHTML = startOut();
  restoreFocus(focus);
}

function copy(button: HTMLElement, id: string) {
  const text = document.getElementById(id)!;
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
  if (act === "copy") return copy(target, id);
  if (act === "close") return sheet.close();
  if (act === "open") {
    openPack = id;
    sheetTab = "overview";
    showSheet(false);
    if (!sheet.open) sheet.showModal();
    return;
  }
  if (act === "sheet-tab") return showTab(id as SheetTab);
  if (act === "tab") {
    tab = id === "profile" ? "profile" : "command";
    return refreshOutputs();
  }
  if (act === "where") {
    const where: Where = id === "hub" ? "hub" : "mac";
    if (picks.where === where) return;
    picks = setWhere(data, picks, where);
  }
  if (act === "preset") picks = presetPicks(data, id, picks.settings, picks.where);
  if (act === "pack") picks = togglePack(data, picks, id);
  if (act === "wf") picks = toggleWorkflow(data, picks, id);
  render();
});

function showTab(tab: SheetTab) {
  rememberOpened();
  sheetTab = tab;
  showSheet(false);
  restoreFocus([`sheet:tab:${tab}`]);
}

sheet.addEventListener("keydown", (event) => {
  const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
  if (!tab || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
  const tabs = [...sheet.querySelectorAll<HTMLElement>('[role="tab"]')];
  const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
  showTab(next.dataset.id as SheetTab);
});

sheet.addEventListener("click", (event) => {
  if (event.target === sheet) sheet.close();
});
sheet.addEventListener("close", () => {
  if (sheet.open) return;
  const closed = openPack;
  openPack = undefined;
  sheet.innerHTML = "";
  restoreFocus([`open:${closed}`]);
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
  refreshOutputs();
}
document.addEventListener("input", (event) => onSetting(event, false));
document.addEventListener("change", (event) => onSetting(event, true));

render();
