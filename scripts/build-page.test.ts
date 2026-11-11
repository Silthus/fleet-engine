import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { LoadedPack, PackManifest } from "../src/pack/types.ts";
import { tempDirs } from "../src/testing/git.ts";
import { spawnAsync } from "../src/testing/spawn.ts";
import { artFiles, packCast } from "../page/cast.ts";
import { packFlows } from "../page/flows.ts";
import { packIcon, packIcons, teamIcon } from "../page/icons.ts";
import { logoMark } from "../page/logo.ts";
import { firstStart, installPrompt, startPrompt, toggleSelected, type PageData, type PromptData } from "../page/model.ts";
import { t3Link } from "../page/prompt.ts";
import { buildSite, pageData, type SiteFiles } from "./build-page.ts";

const root = join(import.meta.dir, "..");
const temp = tempDirs();
afterEach(() => temp.cleanup());

const teamPack = (manifest: Partial<PackManifest> = {}): LoadedPack => ({
  dir: "/team/packs/acme",
  manifest: {
    schema: 1,
    name: "posthog",
    summary: "A team pack.",
    audience: "posthog",
    workflows: [
      { id: "team-devbox", name: "Team devbox", sentence: "Setup makes a team devbox.", needs: ["posthog-org"], default: true, settings: ["posthog.region"] },
    ],
    settings: [{ key: "posthog.region", question: "Which region?", type: "choice", default: "us", ask: "setup", choices: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }] }],
    ...manifest,
  },
});

let data: PageData;
let files: SiteFiles;
beforeAll(async () => {
  data = await pageData({ audience: "public" });
  files = await buildSite({ audience: "public" });
});

const pagesOf = (site: SiteFiles) => Object.entries(site).flatMap(([path, content]) => (path.endsWith(".html") ? [[path, content as string] as const] : []));
const page = (path: string, site = files) => site[path] as string;
const unescaped = (html: string) => html.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
const visibleText = (html: string) => unescaped(html.replace(/<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>|<head>[\s\S]*?<\/head>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const promptOn = (html: string, id: string) => unescaped(html.match(new RegExp(`<pre id="${id}-text"[^>]*>([\\s\\S]*?)</pre>`))![1]!.replace(/<[^>]+>/g, ""));
const t3LinkOn = (html: string, id: string) => unescaped(html.match(new RegExp(`<a class="btn btn-ghost" id="${id}-t3" href="([^"]*)"`))![1]!);
const carried = (html: string) => JSON.parse(html.match(/<script id="fleet-data" type="application\/json">([\s\S]*?)<\/script>/)![1]!) as PromptData;
const boxOf = (html: string, where: string) => html.match(new RegExp(`<section class="box" data-where="${where}">[\\s\\S]*?</section>`))![0];

function localTargets(path: string, html: string) {
  const links = [...html.matchAll(/\s(?:href|src|srcset)="([^"]*)"/g)].map((match) => unescaped(match[1]!));
  return links
    .filter((link) => !/^(https?:|data:|#)/.test(link))
    .map((link) => {
      const target = posix.join(posix.dirname(path), link.replace(/#.*$/, ""));
      return target === "." || target === "./" ? "index.html" : target.endsWith("/") ? `${target}index.html` : target;
    });
}

describe("the site build", () => {
  test("writes one page for the landing, one for the packs, and one for every pack", () => {
    expect(pagesOf(files).map(([path]) => path)).toEqual(["index.html", "packs/index.html", ...data.packs.map((pack) => `packs/${pack.name}/index.html`)]);
    expect(data.packs.map((pack) => pack.name)).toEqual(["base", "pull-requests", "orchestration", "communication", "memory", "guards", "slack", "hub", "mcp-gateway", "recovery"]);
  });

  test("every link and asset on every page leads to a file of the site, from any folder the site is served under", () => {
    for (const [path, html] of pagesOf(files)) {
      const targets = localTargets(path, html);
      expect([path, targets.filter((target) => !(target in files))]).toEqual([path, []]);
      expect([path, targets.length > 5]).toEqual([path, true]);
      expect([path, html.match(/\s(?:href|src|srcset)="\/[^"]*"/g)]).toEqual([path, null]);
    }
  });

  test("the landing page offers two boxes, each with a switch for every default pack, all on", () => {
    const html = page("index.html");
    expect([...html.matchAll(/<input class="sr" type="radio" name="where" id="where-(\w+)" value="\w+"( checked)?>/g)].map((match) => [match[1], Boolean(match[2])])).toEqual([["mac", true], ["hub", false]]);
    for (const where of ["mac", "hub"]) {
      const switches = [...boxOf(html, where).matchAll(/<input type="checkbox" role="switch" class="switch" name="([^"]+)"[^>]*?( checked)?>/g)].map((match) => [match[1], Boolean(match[2])]);
      expect(switches).toEqual(["pull-requests", "orchestration", "communication"].map((pack) => [`${where}:${pack}`, true]));
    }
    expect(visibleText(boxOf(html, "hub"))).toContain("Hub One always-on devbox links and watches the others. Always on");
    expect(visibleText(boxOf(html, "mac"))).toContain("Hub Add a hub later, when you want one.");
    expect(boxOf(html, "mac")).not.toMatch(/name="mac:hub"|Always on/);
  });

  test("the landing page shows the Getting Started prompt for the first box under the boxes, with a link that opens it in T3 Code", () => {
    const html = page("index.html");
    const prompt = startPrompt(data, firstStart);
    expect(promptOn(html, "start")).toBe(prompt);
    expect(t3LinkOn(html, "start")).toBe(`https://app.t3.codes/new?prompt=${encodeURIComponent(prompt)}`);
    expect(html.indexOf('id="start-text"')).toBeGreaterThan(html.lastIndexOf('class="box"'));
    expect(html).toContain('<button type="button" class="btn btn-yellow" data-copy="start-text">Copy prompt</button>');
    for (const text of ["Download T3 Code", "Sign in with T3 Connect", "Paste this prompt", "https://t3.codes"]) expect(html).toContain(text);
    expect(startPrompt(carried(html), { where: "hub", off: ["communication"] })).toBe(startPrompt(data, { where: "hub", off: ["communication"] }));
  });

  test("the landing page lists no pack beyond the packs of the two boxes, and links the packs page", () => {
    const html = page("index.html");
    const boxed = [...data.startPacks, ...data.hubStartPacks];
    const others = data.packs.filter((pack) => !boxed.includes(pack.name));
    expect(others.map((pack) => pack.title)).toEqual(["Base", "Memory", "Guards", "Slack", "MCP gateway", "Recovery"]);
    const text = visibleText(html);
    expect(others.filter((pack) => new RegExp(`\\b${pack.title}\\b`).test(text)).map((pack) => pack.title)).toEqual([]);
    expect(localTargets("index.html", html).filter((target) => target.startsWith("packs/"))).toEqual(expect.arrayContaining(["packs/index.html"]));
    expect(localTargets("index.html", html).filter((target) => /^packs\/.+\//.test(target))).toEqual([]);
  });

  test("the packs page lets a visitor select every pack but Base, and links each pack's own page", () => {
    const html = page("packs/index.html");
    expect(html).toContain("<h1>Extend your <mark>Fleet</mark>.</h1>");
    expect([...html.matchAll(/<input class="sr" type="checkbox" name="pack" id="pick-[^"]+" value="([^"]+)">/g)].map((match) => match[1])).toEqual(data.packs.filter((pack) => !pack.always).map((pack) => pack.name));
    expect(localTargets("packs/index.html", html).filter((target) => /^packs\/.+\//.test(target))).toEqual(data.packs.map((pack) => `packs/${pack.name}/index.html`));
    const everyPack = data.packs.reduce((selected, pack) => (selected.includes(pack.name) ? selected : toggleSelected(data, selected, pack.name)), [] as string[]);
    expect(installPrompt(carried(html), everyPack)).toBe(installPrompt(data, everyPack));
    expect(html).toContain('<button type="button" class="btn btn-yellow" data-copy="install-text">Copy prompt</button>');
    expect(html).toContain('id="install-t3"');
  });

  test("each pack's page carries the prompt that adds that pack and the packs it requires", () => {
    for (const pack of data.packs.filter((item) => !item.always)) {
      const html = page(`packs/${pack.name}/index.html`);
      const prompt = installPrompt(data, toggleSelected(data, [], pack.name));
      expect([pack.name, promptOn(html, "install")]).toEqual([pack.name, prompt]);
      expect([pack.name, t3LinkOn(html, "install")]).toEqual([pack.name, t3Link(prompt)]);
      expect(html).toContain(`data-select="${pack.name}"`);
      expect(visibleText(html)).toContain(pack.summary);
    }
    expect(promptOn(page("packs/orchestration/index.html"), "install")).toContain("fleet packs --add pull-requests --add orchestration");
    const base = page("packs/base/index.html");
    expect(base).toContain("Every Fleet has this pack. You add nothing.");
    expect(base).not.toContain('id="install-text"');
  });

  test("each pack's page shows its workflows, its cost, its risk, and its settings", () => {
    for (const pack of data.packs) {
      const text = visibleText(page(`packs/${pack.name}/index.html`)).replaceAll("`", "");
      const shown = (words: string) => [pack.name, text.includes(words.replaceAll("`", "").replace(/\s+/g, " ")) ? "shown" : words];
      for (const workflow of pack.workflows) expect(shown(workflow.name)).toEqual([pack.name, "shown"]);
      for (const words of [pack.cost, pack.risk]) if (words) expect(shown(words)).toEqual([pack.name, "shown"]);
      for (const setting of pack.settings) expect(shown(setting.key)).toEqual([pack.name, "shown"]);
    }
  });

  test("the public build names no item of a private team pack, and credits PostHog for the hedgehogs and the logo", async () => {
    for (const [path, html] of pagesOf(files)) expect([path, html.match(/hogli|coder|stamphog|reviewhog/gi)]).toEqual([path, null]);
    expect(Buffer.from(files["assets/app.js"] as string).toString().match(/hogli|coder|stamphog|reviewhog/gi)).toBeNull();
    expect(data.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).not.toContain("previews");
    expect(data.teamPacks).toEqual([]);
    for (const [path, html] of pagesOf(files)) {
      expect([path, html.includes('alt="PostHog"')]).toEqual([path, true]);
      expect([path, visibleText(html).includes("The hedgehogs and the PostHog logo belong to PostHog.")]).toEqual([path, true]);
    }
  });

  test("every pack has its own icon and its own hedgehog, and a team pack gets the team icon", () => {
    const icons = data.packs.map((pack) => packIcon(pack.name));
    expect(data.packs.filter((pack) => !packIcons[pack.name]).map((pack) => pack.name)).toEqual([]);
    expect(new Set(icons).size).toBe(icons.length);
    expect(packIcon("acme")).toBe(teamIcon);
    expect(icons).not.toContain(teamIcon);
    expect(Object.keys(packCast).toSorted()).toEqual(data.packs.map((pack) => pack.name).toSorted());
    for (const pack of data.packs) {
      expect(page("packs/index.html")).toContain(`assets/art/${packCast[pack.name]!.art.file}`);
      expect(page(`packs/${pack.name}/index.html`)).toContain(`assets/art/${packCast[pack.name]!.art.file}`);
    }
  });

  test("a build ships each picture its pages show, unchanged, and no other picture", async () => {
    const artDir = join(root, "page/art");
    const team = await buildSite({ audience: "posthog", team: [teamPack()] });
    for (const site of [files, team]) {
      const shipped = Object.keys(site).filter((path) => path.startsWith("assets/art/"));
      const shown = new Set(pagesOf(site).flatMap(([path, html]) => localTargets(path, html)));
      expect(shipped.filter((path) => !shown.has(path))).toEqual([]);
      for (const path of shipped) expect([path, Buffer.from(site[path]!).equals(readFileSync(join(artDir, posix.basename(path))))]).toEqual([path, true]);
    }
    expect(Object.keys(files)).not.toContain("assets/art/heart-hog.png");
    expect(Object.keys(team)).toContain("assets/art/heart-hog.png");
  });

  test("the credits name the source of every picture in the art folder, and the folder holds no picture that no build shows", async () => {
    const artDir = join(root, "page/art");
    const held = readdirSync(artDir).filter((name) => !name.endsWith(".md") && name !== "LICENSE");
    expect(held.toSorted()).toEqual(artFiles().toSorted());
    const credits = readFileSync(join(artDir, "README.md"), "utf8");
    expect(held.filter((name) => !new RegExp(`^\\| \`${name}\` \\| \`[^\`]+/${name}\` \\| \`[0-9a-f]{40}\` \\|$`, "m").test(credits))).toEqual([]);
    expect(readFileSync(join(artDir, "LICENSE"), "utf8")).toStartWith("Copyright (c) 2020-2026 PostHog Inc.");
    const team = await buildSite({ audience: "posthog", team: [teamPack()] });
    expect(held.filter((name) => !(`assets/art/${name}` in team))).toEqual([]);
  });

  test("each flow belongs to a pack of the public site, is short, and shows on that pack's page", () => {
    const names = data.packs.map((pack) => pack.name);
    expect(Object.keys(packFlows).filter((name) => !names.includes(name))).toEqual([]);
    for (const [name, steps] of Object.entries(packFlows)) {
      expect([name, steps.length >= 3 && steps.length <= 5]).toEqual([name, true]);
      expect([name, steps.filter((step) => step.split(" ").length > 7)]).toEqual([name, []]);
      const text = visibleText(page(`packs/${name}/index.html`));
      expect([name, steps.filter((step) => !text.includes(step))]).toEqual([name, []]);
    }
  });

  test("every page, its tab icon, and the README carry the same Fleet logo", () => {
    for (const [path, html] of pagesOf(files)) {
      expect([path, html.includes(`<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(logoMark)}">`)]).toEqual([path, true]);
      expect([path, html.split(logoMark).length]).toEqual([path, 3]);
    }
    expect(readFileSync(join(root, "docs", "fleet-logo.svg"), "utf8").trim()).toBe(logoMark);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain('src="docs/fleet-logo.svg"');
  });

  test("no page shows a day, a moment, a word note, or the old pack dialog", () => {
    for (const [path, html] of pagesOf(files)) expect([path, html.match(/A day with|moments?\b|New word|<dialog|does not ask|short-lived boxes/i)]).toEqual([path, null]);
  });

  test("the public build refuses a private pack source", async () => {
    expect(pageData({ audience: "public", team: [teamPack()] })).rejects.toThrow("no pack from a private source");
    expect(buildSite({ audience: "public", team: [teamPack()] })).rejects.toThrow("no pack from a private source");
  });

  test("a team build puts the team pack in both boxes and in the first setup, and gives it a page", async () => {
    const team = [teamPack({ title: "PostHog" })];
    const teamData = await pageData({ audience: "posthog", team });
    const site = await buildSite({ audience: "posthog", team });
    expect(teamData.teamPacks).toEqual(["posthog"]);
    expect(startPrompt(teamData, firstStart)).toEndWith("- Packs on the first setup: pull-requests, orchestration, communication, posthog");
    expect(startPrompt(teamData, { where: "mac", off: teamData.startPacks })).toEndWith("- Packs on the first setup: posthog");
    const landing = page("index.html", site);
    expect(promptOn(landing, "start")).toBe(startPrompt(teamData, firstStart));
    for (const where of ["mac", "hub"]) {
      expect(visibleText(boxOf(landing, where))).toContain("PostHog A team pack. Your team's pack");
      expect(boxOf(landing, where)).not.toContain(`name="${where}:posthog"`);
    }
    expect(visibleText(page("packs/posthog/index.html", site))).toContain("Team devbox");
    expect(promptOn(page("packs/posthog/index.html", site), "install")).toContain("fleet packs --add posthog");
    expect(teamData.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).toContain("previews");
    for (const [path, html] of pagesOf(site)) expect([path, localTargets(path, html).filter((target) => !(target in site))]).toEqual([path, []]);
  });

  test("a team build shows a pack by its title, and by its capitalised name without one", async () => {
    const teamData = await pageData({ audience: "posthog", team: [teamPack({ title: "PostHog" }), teamPack({ name: "acme", audience: undefined, workflows: [], settings: [] })] });
    expect(teamData.packs.filter((pack) => pack.name === "posthog" || pack.name === "acme").map((pack) => pack.title)).toEqual(["PostHog", "Acme"]);
  });

  test("a workflow that needs a team pack shows only when that pack is in the build, and so do the settings only it lists", async () => {
    const boxes = { id: "team-boxes", name: "Team boxes", sentence: "Heavy work runs on a box.", needs: ["hub" as const, "coder" as const], default: true, settings: ["acme.template"] };
    const acme = (name: string) => teamPack({ name, audience: undefined, workflows: [boxes], settings: [{ key: "acme.template", question: "Which template?", type: "string" }] });
    const ids = (shown: PageData) => shown.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id);
    const keys = (shown: PageData) => shown.packs.flatMap((pack) => pack.settings).map((setting) => setting.key);
    const withTeam = await pageData({ audience: "posthog", team: [acme("posthog")] });
    expect(ids(withTeam)).toContain("team-boxes");
    expect(keys(withTeam)).toContain("acme.template");
    const without = await pageData({ audience: "posthog", team: [acme("acme")] });
    expect(ids(without)).not.toContain("team-boxes");
    expect(keys(without)).not.toContain("acme.template");
  });

  test("the public build shows the Hub pack without its box workflow and box settings", () => {
    const hub = data.packs.find((pack) => pack.name === "hub")!;
    expect(hub.workflows.map((workflow) => workflow.id)).toEqual(["disk-watch", "linked-hub", "dream", "own-account-balancing"]);
    expect(hub.settings.map((setting) => setting.key).filter((key) => key.startsWith("hub.box"))).toEqual([]);
    expect(Object.keys(data.needLabels)).not.toContain("coder");
  });

  test("the README's overview picture says in its alt text what the picture's own description says", () => {
    const description = readFileSync(join(root, "docs", "fleet.svg"), "utf8").match(/<desc[^>]*>([^<]+)<\/desc>/)![1]!;
    expect(description.length).toBeGreaterThan(40);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(`alt="${description}"`);
  });

  test("the command line writes the site for a pack source into the folder of --out, and refuses a single HTML file", async () => {
    const source = temp.make("source-");
    mkdirSync(join(source, "packs", "posthog"), { recursive: true });
    writeFileSync(join(source, "packs", "posthog", "pack.json"), JSON.stringify(teamPack().manifest));
    const out = join(temp.make("out-"), "site");
    const run = await spawnAsync(["bun", join(root, "scripts/build-page.ts"), "--audience", "posthog", "--source", source, "--out", out], { cwd: root });
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain('"teamPacks":["posthog"]');
    for (const path of ["packs/index.html", "packs/posthog/index.html", "assets/site.css", "assets/app.js", "assets/art/posthog-logo-light.svg", "assets/art/heart-hog.png"]) expect([path, existsSync(join(out, path))]).toEqual([path, true]);
    const single = await spawnAsync(["bun", join(root, "scripts/build-page.ts"), "--out", join(out, "index.html")], { cwd: root });
    expect([single.exitCode, single.stderr.trim()]).toEqual([2, "build-page: --out takes a directory. The site has one HTML file for each route"]);
  });

  test("the command line ends once it writes a build, also for a pack.ts whose helper keeps a timer", async () => {
    const source = temp.make("source-");
    mkdirSync(join(source, "packs", "team"), { recursive: true });
    writeFileSync(join(source, "packs", "team", "pack.ts"), `setInterval(() => {}, 3_600_000);\nexport default { sdk: 1, name: "team", summary: "Team rules.", register() {} };\n`);
    const out = temp.make("out-");
    const run = await spawnAsync(["bun", join(root, "scripts/build-page.ts"), "--audience", "posthog", "--source", source, "--out", out], { cwd: root, timeout: 4000 });
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain('"teamPacks":["team"]');
  });
});
