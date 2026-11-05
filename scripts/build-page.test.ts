import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedPack, PackManifest } from "../src/pack/types.ts";
import { tempDirs } from "../src/testing/git.ts";
import { presetPicks, commandFlags, setSetting, questions } from "../page/model.ts";
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
      { id: "team-devbox", name: "Team devbox", sentence: "Setup makes a team devbox.", needs: ["posthog-org"], default: true, settings: ["posthog.region"], moment: { time: "08:45", title: "Your devbox is up", body: "It runs.", words: ["Coder"] } },
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
    expect(data.packs.map((pack) => pack.name)).toEqual(["base", "pull-requests", "orchestration", "communication", "memory", "hub"]);
    expect(data.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).not.toContain("previews");
  });

  test("the public build refuses a private pack source", async () => {
    expect(pageData({ audience: "public", team: [teamPack()] })).rejects.toThrow("no pack from a private source");
  });

  test("a team build ticks the team pack in every preset and shows its words", async () => {
    const data = await pageData({ audience: "posthog", team: [teamPack()] });
    for (const preset of data.presets) expect([preset.id, presetPicks(data, preset.id).packs]).toEqual([preset.id, expect.arrayContaining(["posthog"])]);
    expect(data.concepts.map((concept) => concept.word)).toContain("Coder");
    expect(data.packs.flatMap((pack) => pack.workflows).map((workflow) => workflow.id)).toContain("previews");
    const eu = setSetting(data, presetPicks(data, "everyday"), "posthog.region", "eu");
    expect(commandFlags(data, eu)).toEqual(["--preset", "everyday", "--set", "posthog.region=eu"]);
    expect(questions(data, eu).count).toBe(questions(data, presetPicks(data, "everyday")).count - 1);
  });

  test("a team build shows a pack by its title, and by its capitalised name without one", async () => {
    const data = await pageData({ audience: "posthog", team: [teamPack({ title: "PostHog" }), teamPack({ name: "acme", audience: undefined, workflows: [], settings: [] })] });
    expect(data.packs.filter((pack) => pack.name === "posthog" || pack.name === "acme").map((pack) => pack.title)).toEqual(["PostHog", "Acme"]);
    expect(data.teamNote).toStartWith("The PostHog and Acme pack");
  });

  test("a workflow that needs a team pack shows only when that pack is in the build, and so do the settings only it lists", async () => {
    const boxes = { id: "team-boxes", name: "Team boxes", sentence: "Heavy work runs on a box.", needs: ["hub" as const, "coder" as const], default: true, settings: ["acme.template"], moment: { time: "13:00", title: "Tests on a box", body: "A box runs them." } };
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
    expect(hub.workflows.map((workflow) => workflow.id)).toEqual(["mcp-gateway", "disk-watch", "linked-hub", "slack-trigger"]);
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
    const run = Bun.spawnSync(["bun", join(root, "scripts/build-page.ts"), "--audience", "posthog", "--source", source, "--out", out], { cwd: root });
    expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
    expect(readFileSync(out, "utf8")).toContain('"teamPacks":["posthog"]');
  });
});
