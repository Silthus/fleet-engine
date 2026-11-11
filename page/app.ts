/// <reference lib="dom" />
import type { PackSetting } from "../src/pack/types.ts";
import { packFlows } from "./flows.ts";
import { brandIcons, packIcon, uiIcons } from "./icons.ts";
import { landingExtras } from "./landing.ts";
import { logoMark } from "./logo.ts";
import { firstStart, installPrompt, listed, setupSplit, startPrompt, toggleExtra, toggleSelected, whereLabels, type PageData, type PagePack, type PageWorkflow, type Start, type Where } from "./model.ts";

type SheetTab = "overview" | "workflows" | "settings";
type PromptId = "start" | "install";

const data: PageData = JSON.parse(document.getElementById("fleet-data")!.textContent!);
let start: Start = firstStart;
let selected: string[] = [];
let openPack: string | undefined;
let sheetTab: SheetTab = "overview";
const shownLines = new Map<PromptId, string[]>();
const sheet = document.getElementById("pack-sheet") as HTMLDialogElement;

const esc = (text: unknown) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const fmt = (text: string) => esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const packOf = (name: string) => data.packs.find((pack) => pack.name === name)!;
const needsHub = (pack: PagePack) => data.needsHubPacks.includes(pack.name);
const isSelected = (pack: PagePack) => selected.includes(pack.name);
const iconTile = (name: string, size = "") => `<span class="icon ${size} ${brandIcons.has(name) ? "brand" : ""}">${packIcon(name)}</span>`;
const repoUrl = `https://github.com/${data.engineRepo}`;
const promptOf = (id: PromptId) => (id === "start" ? startPrompt(data, start) : installPrompt(data, selected));
const t3Link = (prompt: string) => `https://app.t3.codes/new?prompt=${encodeURIComponent(prompt)}`;

function topBar() {
  return `<header class="top"><div class="wrap top-in">
    <a class="wordmark" href="#top"><span aria-hidden="true">${logoMark}</span><span>Fleet</span></a>
    <nav aria-label="On this page"><a href="#start">Get started</a><a href="#packs">Packs</a><a href="${repoUrl}" target="_blank" rel="noopener">GitHub</a></nav>
  </div></header>`;
}

function hero() {
  return `<section class="hero" id="top"><div class="wrap hero-in">
    <div class="hero-text">
      <h1><span>Set up your coding agents once.</span> <span>Every machine gets the same setup.</span></h1>
      <p class="lead">Coding agents get much better with good rules, skills, and a machine that stays on. Setting that up by hand takes a day for each machine, and the machines drift apart.</p>
      <p>Fleet sets up T3 Code, Claude Code, Codex, and a set of agent workflows on your Mac and your Linux devboxes. You pick the workflows as <b>packs</b>. Your answers live in your own private <b>profile</b> repo, so every machine gets the same setup.</p>
      <p class="cta"><a class="btn-solid big" href="#start">Get started</a><a class="btn-line big" href="#packs">See the packs</a></p>
    </div>
    <figure class="overview"><img src="${data.overview.image}" alt="${esc(data.overview.alt)}" width="760" height="330"></figure>
  </div></section>`;
}

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

const whereNotes: Record<Where, { badge: string; facts: string[] }> = {
  mac: {
    badge: "Simplest start",
    facts: ["Agents run on your Mac, and stop when it sleeps.", "Add a hub and a node later, when you want agents to work overnight."],
  },
  hub: {
    badge: "Agents work overnight",
    facts: ["Two Linux devboxes in the cloud stay on while your Mac sleeps.", "Threads do the work on the node. The hub links your machines and watches their disks."],
  },
};

function whereTab(where: Where) {
  const on = start.where === where;
  return `<label class="where ${on ? "on" : ""}" data-act="where" data-id="${where}">
    <input type="radio" name="where" value="${where}" data-focus="where:${where}" ${on ? "checked" : ""}>
    <span class="where-name">${whereLabels[where]}</span><span class="badge">${whereNotes[where].badge}</span>
  </label>`;
}

function extraRow(name: string) {
  const pack = packOf(name);
  const on = start.extras.includes(name);
  return `<button class="extra ${on ? "on" : ""}" role="switch" aria-checked="${on}" data-act="extra" data-id="${esc(name)}" data-focus="extra:${esc(name)}">
    ${iconTile(name, "mini")}<span class="extra-text"><b>${esc(pack.title)}</b><span>${esc(landingExtras[name] ?? pack.summary)}</span></span><span class="switch" aria-hidden="true"></span>
  </button>`;
}

function setupPane() {
  const included = data.packs.filter((pack) => data.startPacks.includes(pack.name) || (start.where === "hub" && data.hubStartPacks.includes(pack.name)));
  const chips = included.map((pack) => `<li class="chip ${data.hubStartPacks.includes(pack.name) ? "new" : ""}">${iconTile(pack.name, "mini")}${esc(pack.title)}</li>`).join("");
  return `<div class="setup">
    ${whereDiagram(start.where)}
    <ul class="where-facts">${whereNotes[start.where].facts.map((fact) => `<li>${esc(fact)}</li>`).join("")}</ul>
    <div class="group"><p class="eyebrow">On in this setup</p><ul class="chips">${chips}</ul></div>
    <div class="group" role="group" aria-labelledby="extras-h"><p class="eyebrow" id="extras-h">Add up to ${plural(data.extraPacks.length, "extra")}</p>${data.extraPacks.map(extraRow).join("")}</div>
    <p class="muted small"><a href="#packs">See what each pack does</a></p>
  </div>`;
}

const pickLine = /^(- [^:]+: |Add th(?:is|ese) Fleet packs? to my setup with me: )(.*)$/;
const commandLine = /^( +)(fleet packs --add .*)$/;

function promptHtml(id: PromptId, text: string) {
  const before = shownLines.get(id);
  const lines = text.split("\n");
  shownLines.set(id, lines);
  return lines
    .map((line) => {
      const parts = line.match(pickLine) ?? line.match(commandLine);
      const body = parts ? `${esc(parts[1])}<span class="tok">${esc(parts[2])}</span>` : esc(line);
      return before?.length && !before.includes(line) ? `<span class="fresh">${body}</span>` : body;
    })
    .join("\n");
}

function promptCard(id: PromptId, title: string, note: string) {
  const text = promptOf(id);
  return `<div class="out">
    <div class="out-head"><span class="out-title">${title}</span><span class="out-note">${esc(note)}</span></div>
    <pre id="${id}-text" tabindex="0" aria-label="${title}">${promptHtml(id, text)}</pre>
    <div class="out-foot"><button class="btn-solid" data-act="copy" data-id="${id}" data-focus="copy:${id}">Copy prompt</button><a class="btn-ghost" data-focus="t3:${id}" href="${t3Link(text)}" target="_blank" rel="noopener">Open in T3 Code${uiIcons.arrow}</a></div>
  </div>`;
}

function startPromptNote() {
  const { first, later } = setupSplit(data, start);
  return start.where === "hub" ? `Base and ${plural(first.length, "pack")} now, ${plural(later.length, "pack")} once the hub runs` : `Base and ${plural(first.length, "pack")}`;
}

function startSection() {
  return `<section id="start" class="band" aria-labelledby="start-h"><div class="wrap">
    <header class="band-head"><h2 id="start-h">Where should your agents run?</h2><p class="muted prose">Choose one. The prompt changes with your choice, and an agent sets up the rest with you.</p></header>
    <div class="console">
      <fieldset class="wheres"><legend class="sr">Where Fleet runs</legend>${whereTab("mac")}${whereTab("hub")}</fieldset>
      <div class="console-body">
        ${setupPane()}
        <div class="paste">
          <ol class="steps">
            <li><span><b>Download T3 Code.</b> Get <a href="https://t3.codes" target="_blank" rel="noopener">T3 Code</a> and open it. Its Welcome page sets up one agent and signs you in.</span></li>
            <li><span><b>Sign in with T3 Connect.</b> Open <b>Settings → Sharing &amp; access</b>, sign in, and turn on T3 Connect.</span></li>
            <li><span><b>Paste this prompt</b> into a new thread in T3 Code on your Mac.</span></li>
          </ol>
          ${promptCard("start", "Your prompt", startPromptNote())}
        </div>
      </div>
    </div>
    <p class="muted small after">The agent explains each part and runs the steps itself. You answer its questions and do your own sign-ins. Do you prefer a terminal? <a href="${repoUrl}#set-it-up-by-hand" target="_blank" rel="noopener">Set it up by hand</a>.</p>
  </div></section>`;
}

function packTag(pack: PagePack) {
  if (pack.always) return '<span class="badge">On every machine</span>';
  if (needsHub(pack)) return '<span class="badge hub">Needs a hub</span>';
  if (data.startPacks.includes(pack.name)) return '<span class="badge">On by default</span>';
  return "";
}

function packCard(pack: PagePack) {
  const on = isSelected(pack);
  const pick = pack.always
    ? ""
    : `<label class="pick"><input type="checkbox" data-act="select" data-id="${esc(pack.name)}" data-focus="select:${esc(pack.name)}" ${on ? "checked" : ""}><span>${on ? "Selected" : "Select"}</span><span class="sr"> the ${esc(pack.title)} pack</span></label>`;
  return `<article class="pack ${on ? "on" : ""}">
    <button class="pack-open" data-act="open" data-id="${esc(pack.name)}" data-focus="open:${esc(pack.name)}" aria-haspopup="dialog">
      ${iconTile(pack.name)}<span class="pack-name">${esc(pack.title)}${uiIcons.arrow}</span><span class="pack-sum">${fmt(pack.summary)}</span>
    </button>
    <div class="pack-foot">${packTag(pack)}${pick}</div>
  </article>`;
}

function installPane() {
  if (!selected.length) {
    shownLines.delete("install");
    return `<div class="out empty"><div class="out-head"><span class="out-title">Your install prompt</span></div><p>Select one or more packs. The prompt that adds them to your fleet appears here.</p></div>`;
  }
  const titles = selected.map((name) => packOf(name).title);
  return `${promptCard("install", "Your install prompt", plural(selected.length, "pack"))}
    <p class="muted small">Paste it into a new thread in T3 Code on a machine that runs Fleet. It adds ${esc(listed(titles))}.</p>`;
}

function packsSection() {
  return `<section id="packs" class="band" aria-labelledby="packs-h"><div class="wrap">
    <header class="band-head"><h2 id="packs-h">Extend Fleet with packs</h2><p class="muted prose">A pack is a set of workflows that you turn on as a whole. Select a pack to read what it does. Do you already run Fleet? Select the packs you want, and one prompt adds them.</p></header>
    <div class="extend">
      <div class="packs">${data.packs.map(packCard).join("")}</div>
      <aside class="install" id="install" aria-label="Install prompt">${installPane()}</aside>
    </div>
    <p class="aud">${iconTile(data.teamPacks[0] ?? "", "mini")}<span>${esc(data.teamNote)}</span></p>
  </div></section>`;
}

function tray() {
  if (!selected.length) return "";
  return `<div class="tray"><span>${plural(selected.length, "pack")} selected</span><a class="btn-solid" href="#install">See the prompt</a></div>`;
}

const flowFigure = (steps: string[]) => `<ol class="flow">${steps.map((step) => `<li><span class="flow-step">${esc(step)}</span></li>`).join("")}</ol>`;

function needChips(pack: PagePack, workflow: PageWorkflow) {
  return workflow.needs
    .filter((need) => data.needPacks[need] !== pack.name)
    .map((need) => `<span class="need">needs ${esc(data.needLabels[need] ?? need)}</span>`)
    .join("");
}

function workflowRows(pack: PagePack) {
  return pack.workflows
    .map(
      (workflow) => `<div class="wf ${workflow.default ? "" : "wf-off"}">
        <div class="wf-body"><div class="wf-name">${esc(workflow.name)}</div>
          <div class="wf-sentence">${fmt(workflow.sentence)}</div>
          <div class="needs"><span class="need ${workflow.default ? "starts-on" : ""}">${workflow.default ? "on with the pack" : "off until you turn it on"}</span><span class="need"><code>${esc(workflow.id)}</code></span>${needChips(pack, workflow)}</div>
          ${workflow.risk ? `<details class="sub risk"><summary>Read before you turn it on</summary><p class="warn">${fmt(workflow.risk)}</p></details>` : ""}
        </div></div>`,
    )
    .join("");
}

function settingRow(setting: PackSetting) {
  const value = setting.default === undefined || setting.default === "" ? "setup asks" : `default ${String(setting.default)}`;
  return `<div class="setting"><p>${esc(setting.question)}</p><p class="needs"><span class="need"><code>${esc(setting.key)}</code></span><span class="need">${esc(value)}</span></p></div>`;
}

function sheetOverview(pack: PagePack) {
  const flow = packFlows[pack.name];
  const startsOn = pack.workflows.filter((workflow) => workflow.default).length;
  const needs = [...new Set(pack.workflows.flatMap((workflow) => workflow.needs))].filter((need) => data.needPacks[need] !== pack.name).map((need) => data.needLabels[need] ?? need);
  const required = pack.requires.map((name) => `the ${packOf(name).title} pack`);
  const asks = listed([...needs, ...required]);
  return `<p class="sheet-lede">${fmt(pack.summary)}</p>
    ${flow ? flowFigure(flow) : pack.name === data.needPacks.hub ? `<div class="flow">${whereDiagram("hub")}</div>` : ""}
    ${pack.day ? `<div class="example"><p class="eyebrow">For example</p><p>${fmt(pack.day)}</p></div>` : ""}
    ${needsHub(pack) ? '<div class="example"><p>This pack runs on a hub. The install prompt checks for one, and offers to add a hub and a node when you have none.</p></div>' : ""}
    <div class="facts">
      <div class="fact"><p class="eyebrow">Workflows</p><p class="fact-big">${startsOn} of ${pack.workflows.length} start on</p><button class="link" data-act="sheet-tab" data-id="workflows" data-focus="sheet:see">See the workflows</button></div>
      <div class="fact"><p class="eyebrow">Needs</p><p>${asks ? esc(asks[0]!.toUpperCase() + asks.slice(1)) : "Nothing extra"}</p></div>
      ${pack.cost ? `<div class="fact"><p class="eyebrow">Cost</p><p>${fmt(pack.cost)}</p></div>` : ""}
    </div>
    ${pack.risk ? `<div class="warn"><p class="eyebrow">Know before you turn it on</p><p>${fmt(pack.risk)}</p></div>` : ""}`;
}

function sheetPanel(pack: PagePack, tab: SheetTab) {
  if (tab === "workflows") return `<p class="muted">Turn a workflow on or off later with ${fmt("`fleet packs --workflows <id>=on`")} or ${fmt("`<id>=off`")}.</p><div class="wfs">${workflowRows(pack)}</div>`;
  if (tab === "settings") return `<p class="muted">Each setting has a default, or setup asks you for it. Change one later with ${fmt("`fleet set <key>=<value>`")}.</p><div class="settings">${pack.settings.map(settingRow).join("")}</div>`;
  return sheetOverview(pack);
}

function packStatus(pack: PagePack) {
  if (pack.always) return "On every machine";
  if (isSelected(pack)) return "In your install prompt";
  if (needsHub(pack)) return "Needs a hub";
  return data.startPacks.includes(pack.name) ? "On by default" : "Optional";
}

function packSheet(pack: PagePack) {
  const on = isSelected(pack);
  const control = pack.always
    ? ""
    : `<button class="${on ? "btn-line" : "btn-solid"} sheet-pick" aria-pressed="${on}" data-act="select" data-id="${esc(pack.name)}" data-focus="sheet:select">${on ? "Remove from the prompt" : "Add to the install prompt"}</button>`;
  const tabs: Array<[SheetTab, string]> = [["overview", "Overview"], ["workflows", `Workflows (${pack.workflows.length})`], ...(pack.settings.length ? [["settings", `Settings (${pack.settings.length})`] as [SheetTab, string]] : [])];
  const tab = tabs.some(([id]) => id === sheetTab) ? sheetTab : "overview";
  return `<header class="sheet-head">
      ${iconTile(pack.name, "big")}
      <div class="sheet-title"><h2 id="sheet-title">${esc(pack.title)}</h2><p class="status">${packStatus(pack)}</p></div>
      ${control}
      <button class="sheet-x" data-act="close" data-focus="sheet:close" aria-label="Close">${uiIcons.close}</button>
    </header>
    <div class="sheet-tabs" role="tablist" aria-label="${esc(pack.title)} pack sections">${tabs.map(([id, label]) => `<button role="tab" id="tab-${id}" aria-selected="${id === tab}" aria-controls="sheet-panel" tabindex="${id === tab ? 0 : -1}" data-act="sheet-tab" data-id="${id}" data-focus="sheet:tab:${id}">${label}</button>`).join("")}</div>
    <div class="sheet-body" id="sheet-panel" role="tabpanel" aria-labelledby="tab-${tab}">${sheetPanel(pack, tab)}</div>`;
}

function showSheet(keepScroll: boolean) {
  const scrolled = keepScroll ? (sheet.querySelector(".sheet-body")?.scrollTop ?? 0) : 0;
  sheet.innerHTML = packSheet(packOf(openPack!));
  sheet.querySelector(".sheet-body")!.scrollTop = scrolled;
}

function footer() {
  return `<footer class="foot"><div class="wrap"><p>Fleet is open source. Read the code and the docs at <a href="${repoUrl}" target="_blank" rel="noopener">github.com/${esc(data.engineRepo)}</a>.</p></div></footer>`;
}

const focusOf = () => {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active.dataset.focus : undefined;
};

function restoreFocus(key: string | undefined) {
  const target = key ? document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`) : null;
  target?.focus({ preventScroll: true });
}

function render() {
  const focus = focusOf();
  const top = window.scrollY;
  document.getElementById("app")!.innerHTML = `${topBar()}<main>${hero()}${startSection()}${packsSection()}</main>${footer()}${tray()}`;
  document.body.classList.toggle("has-tray", selected.length > 0);
  window.scrollTo(0, top);
  if (openPack) showSheet(true);
  restoreFocus(focus);
}

function copy(button: HTMLElement, id: PromptId) {
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById(`${id}-text`)!);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    button.textContent = "Selected: press Ctrl-C or ⌘C";
  };
  if (!navigator.clipboard) return select();
  navigator.clipboard.writeText(promptOf(id)).then(() => (button.textContent = "Copied"), select);
}

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!target) return;
  const { act, id = "" } = target.dataset;
  if (act === "copy") return copy(target, id as PromptId);
  if (act === "close") return sheet.close();
  if (act === "sheet-tab") return showTab(id as SheetTab);
  if (act === "open") {
    openPack = id;
    sheetTab = "overview";
    showSheet(false);
    if (!sheet.open) sheet.showModal();
    return;
  }
  if (act === "where") {
    const where: Where = id === "hub" ? "hub" : "mac";
    if (start.where === where) return;
    start = { ...start, where };
  }
  if (act === "extra") start = toggleExtra(data, start, id);
  if (act === "select") selected = toggleSelected(data, selected, id);
  render();
});

function showTab(tab: SheetTab) {
  sheetTab = tab;
  showSheet(false);
  restoreFocus(`sheet:tab:${tab}`);
}

sheet.addEventListener("keydown", (event) => {
  const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
  if (!tab || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
  event.preventDefault();
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
  restoreFocus(`open:${closed}`);
});

render();
