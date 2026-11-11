import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedPack, PackManifest } from "../src/pack/types.ts";
import { tempDirs } from "../src/testing/git.ts";
import { spawnAsync } from "../src/testing/spawn.ts";
import { firstStart, installPrompt, startPrompt, toggleSelected } from "../page/model.ts";
import { landingExtras } from "../page/landing.ts";
import { packFlows } from "../page/flows.ts";
import { packIcon, packIcons, teamIcon } from "../page/icons.ts";
import { logoMark } from "../page/logo.ts";
import { buildPage, pageData } from "./build-page.ts";

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

describe("the page build", () => {
  test("the committed public page is the generator's output", async () => {
    expect(await buildPage({ audience: "public" })).toBe(readFileSync(join(root, "page/index.html"), "utf8"));
  });

  test("the public build names no PostHog item, Coder, or hogli anywhere", async () => {
    const html = await buildPage({ audience: "public" });
    expect(html.match(/posthog|hogli|coder|stamphog|reviewhog/gi)).toBeNull();
    const data = await pageData({ audience: "public" });
    expect(data.packs.map((pack) => pack.name)).toEqual(["base", "pull-requests", "orchestration", "communication", "memory", "guards", "slack", "hub", "mcp-gateway", "recovery"]);
    expect(data.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).not.toContain("previews");
  });

  test("every pack on the public page has its own icon, and a team pack gets the team icon", async () => {
    const data = await pageData({ audience: "public" });
    const icons = data.packs.map((pack) => packIcon(pack.name));
    expect(data.packs.filter((pack) => !packIcons[pack.name]).map((pack) => pack.name)).toEqual([]);
    expect(new Set(icons).size).toBe(icons.length);
    expect(packIcon("acme")).toBe(teamIcon);
    expect(icons).not.toContain(teamIcon);
  });

  test("the page shows no day, moment, or word note", async () => {
    expect(await buildPage({ audience: "public" })).not.toMatch(/A day with|moments?\b|New word/i);
  });

  test("each pack opens in a dialog, and each flow belongs to a pack on the public page and is short", async () => {
    const html = await buildPage({ audience: "public" });
    expect(html).toContain('<dialog id="pack-sheet" aria-labelledby="sheet-title">');
    const data = await pageData({ audience: "public" });
    const names = data.packs.map((pack) => pack.name);
    expect(Object.keys(packFlows).filter((name) => !names.includes(name))).toEqual([]);
    for (const [name, steps] of Object.entries(packFlows)) {
      expect([name, steps.length >= 3 && steps.length <= 5]).toEqual([name, true]);
      expect([name, steps.filter((step) => step.split(" ").length > 7)]).toEqual([name, []]);
    }
  });

  test("the page leads in with the problem, what Fleet does, and the overview picture from the README", async () => {
    const html = await buildPage({ audience: "public" });
    const data = await pageData({ audience: "public" });
    const readme = readFileSync(join(root, "README.md"), "utf8").replace(/\s+/g, " ").replaceAll("**", "");
    for (const text of ["Coding agents get much better with good rules, skills, and a machine that stays on.", "Fleet sets up T3 Code, Claude Code, Codex, and a set of agent workflows on your Mac and your Linux devboxes."]) {
      expect(html).toContain(text);
      expect(readme).toContain(text);
    }
    const picture = readFileSync(join(root, "docs", "fleet.svg"), "utf8");
    expect(decodeURIComponent(data.overview.image)).toBe(`data:image/svg+xml,${picture}`);
    expect(data.overview.alt.length).toBeGreaterThan(40);
    expect(picture).toContain(`>${data.overview.alt}</desc>`);
    expect(readme).toContain(`alt="${data.overview.alt}"`);
  });

  test("the page, its tab icon, and the README carry the same Fleet logo", async () => {
    const html = await buildPage({ audience: "public" });
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(logoMark)}">`);
    expect(html.split(logoMark).length).toBe(2);
    expect(readFileSync(join(root, "docs", "fleet-logo.svg"), "utf8").trim()).toBe(logoMark);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain('src="docs/fleet-logo.svg"');
  });

  test("the page gives the Getting started steps and a prompt that opens in T3 Code", async () => {
    const html = await buildPage({ audience: "public" });
    for (const text of ["Download T3 Code", "Sign in with T3 Connect", "Paste this prompt", "https://t3.codes", "https://app.t3.codes/new?prompt="]) expect(html).toContain(text);
  });

  test("each extra on the landing has its own short line", async () => {
    const data = await pageData({ audience: "public" });
    expect(Object.keys(landingExtras)).toEqual(data.extraPacks);
    expect(Object.values(landingExtras).filter((text) => text.split(" ").length > 9 || !text.endsWith("."))).toEqual([]);
  });

  test("the public build refuses a private pack source", async () => {
    expect(pageData({ audience: "public", team: [teamPack()] })).rejects.toThrow("no pack from a private source");
  });

  test("a team build puts the team pack in the Getting started prompt, shows its workflows, and names its setup note in the install prompt", async () => {
    const source = temp.make("source-");
    mkdirSync(join(source, "packs", "posthog"), { recursive: true });
    writeFileSync(join(source, "packs", "posthog", "SETUP.md"), "# Setup note\n");
    const data = await pageData({ audience: "posthog", team: [{ ...teamPack(), dir: join(source, "packs", "posthog") }] });
    expect(startPrompt(data, firstStart)).toEndWith("- Packs on the first setup: pull-requests, orchestration, communication, posthog");
    expect(data.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).toContain("previews");
    const prompt = installPrompt(data, toggleSelected(data, [], "posthog"));
    expect(prompt).toContain("   - Posthog: ~/.local/share/fleet/sources/<source>/packs/posthog/SETUP.md\n   `<source>` is the folder in `~/.local/share/fleet/sources` that holds the pack.\n");
    expect(installPrompt(await pageData({ audience: "public" }), ["memory"])).not.toContain("<source>");
  });

  test("a team build shows a pack by its title, and by its capitalised name without one", async () => {
    const data = await pageData({ audience: "posthog", team: [teamPack({ title: "PostHog" }), teamPack({ name: "acme", audience: undefined, workflows: [], settings: [] })] });
    expect(data.packs.filter((pack) => pack.name === "posthog" || pack.name === "acme").map((pack) => pack.title)).toEqual(["PostHog", "Acme"]);
    expect(data.teamNote).toStartWith("The PostHog and Acme pack");
  });

  test("a workflow that needs a team pack shows only when that pack is in the build, and so do the settings only it lists", async () => {
    const boxes = { id: "team-boxes", name: "Team boxes", sentence: "Heavy work runs on a box.", needs: ["hub" as const, "coder" as const], default: true, settings: ["acme.template"] };
    const acme = (name: string) => teamPack({ name, audience: undefined, workflows: [boxes], settings: [{ key: "acme.template", question: "Which template?", type: "string" }] });
    const ids = (data: { packs: Array<{ workflows: Array<{ id: string }> }> }) => data.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id);
    const keys = (data: { packs: Array<{ settings: Array<{ key: string }> }> }) => data.packs.flatMap((pack) => pack.settings).map((setting) => setting.key);
    const withTeam = await pageData({ audience: "posthog", team: [acme("posthog")] });
    expect(ids(withTeam)).toContain("team-boxes");
    expect(keys(withTeam)).toContain("acme.template");
    expect(withTeam.needPacks).toEqual({ hub: "hub", coder: "posthog" });
    const without = await pageData({ audience: "posthog", team: [acme("acme")] });
    expect(ids(without)).not.toContain("team-boxes");
    expect(keys(without)).not.toContain("acme.template");
  });

  test("the public build shows the Hub pack without its box workflow and box settings", async () => {
    const data = await pageData({ audience: "public" });
    const hub = data.packs.find((pack) => pack.name === "hub")!;
    expect(hub.workflows.map((workflow) => workflow.id)).toEqual(["disk-watch", "linked-hub", "dream", "own-account-balancing"]);
    expect(hub.settings.map((setting) => setting.key).filter((key) => key.startsWith("hub.box"))).toEqual([]);
    expect(data.needPacks).toEqual({ hub: "hub" });
    expect(await buildPage({ audience: "public" })).not.toMatch(/short-lived boxes|box · /);
  });

  test("the command line writes a build for a pack source to --out", async () => {
    const source = temp.make("source-");
    const manifest = teamPack().manifest;
    mkdirSync(join(source, "packs", "posthog"), { recursive: true });
    writeFileSync(join(source, "packs", "posthog", "pack.json"), JSON.stringify(manifest));
    const out = join(temp.make("out-"), "index.html");
    const run = await spawnAsync(["bun", join(root, "scripts/build-page.ts"), "--audience", "posthog", "--source", source, "--out", out], { cwd: root });
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(readFileSync(out, "utf8")).toContain('"teamPacks":["posthog"]');
  });

  test("the command line ends once it writes a build, also for a pack.ts whose helper keeps a timer", async () => {
    const source = temp.make("source-");
    mkdirSync(join(source, "packs", "team"), { recursive: true });
    writeFileSync(join(source, "packs", "team", "pack.ts"), `setInterval(() => {}, 3_600_000);\nexport default { sdk: 1, name: "team", summary: "Team rules.", register() {} };\n`);
    const out = join(temp.make("out-"), "index.html");
    const run = await spawnAsync(["bun", join(root, "scripts/build-page.ts"), "--audience", "posthog", "--source", source, "--out", out], { cwd: root, timeout: 4000 });
    expect([run.exitCode, run.stderr]).toEqual([0, ""]);
    expect(readFileSync(out, "utf8")).toContain('"teamPacks":["team"]');
  });
});
