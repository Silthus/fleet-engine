import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";
import { codexInstaller, t3Busy, updateAgents, updatePlugins, updateT3, type Run, type T3Options } from "./agent-update.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

const fleetCodex = 'sh -c readlink "$HOME/.local/bin/codex"';

function stub(results: Record<string, { code: number; out: string }>) {
  const calls: string[] = [];
  const run: Run = async (command) => {
    calls.push(command.join(" "));
    return results[command.join(" ")] ?? { code: 127, out: "" };
  };
  return { run, calls };
}

test("updates the agent CLIs that Fleet installed", async () => {
  const { run, calls } = stub({
    'sh -c test -x "$HOME/.local/bin/claude" && echo native': { code: 0, out: "native\n" },
    "claude update": { code: 0, out: "" },
    "bun pm ls -g": { code: 0, out: "├── @openai/codex@0.9.0" },
    "bun add -g @openai/codex@latest": { code: 0, out: "" },
  });
  expect(await updateAgents(run)).toEqual({ ok: true, lines: ["Claude Code: up to date.", "Codex: not installed by Fleet, skipped.", "Codex from Bun: up to date."] });
  expect(calls).toContain("bun add -g @openai/codex@latest");
});

test.each([
  ["through its current release", "/home/me/.local/share/fleet/codex/current/bin/codex\n"],
  ["from the earlier single-folder layout", "/home/me/.local/share/fleet/codex/bin/codex\n"],
])("updates the Codex that Fleet installed from its release package %s", async (_layout, target) => {
  const { run, calls } = stub({ [fleetCodex]: { code: 0, out: target }, [`sh ${codexInstaller}`]: { code: 0, out: "" }, "bun pm ls -g": { code: 0, out: "" } });
  expect((await updateAgents(run)).lines).toEqual(["Claude Code: not installed by Fleet, skipped.", "Codex: up to date.", "Codex from Bun: not installed by Fleet, skipped."]);
  expect(calls).toContain(`sh ${codexInstaller}`);
  expect(codexInstaller).toEndWith("packs/base/lib/install-codex.sh");
});

test("skips a CLI that is missing and reports a failed update", async () => {
  const { run, calls } = stub({ 'sh -c test -x "$HOME/.local/bin/claude" && echo native': { code: 0, out: "native\n" }, "claude update": { code: 1, out: "" }, "bun pm ls -g": { code: 0, out: "typescript" } });
  expect(await updateAgents(run)).toEqual({ ok: false, lines: ["Claude Code: update failed (exit 1).", "Codex: not installed by Fleet, skipped.", "Codex from Bun: not installed by Fleet, skipped."] });
  expect(calls).not.toContain("bun add -g @openai/codex@latest");
});

test("leaves a Claude Code that a package manager installed to that manager", async () => {
  const { run, calls } = stub({ 'sh -c test -x "$HOME/.local/bin/claude" && echo native': { code: 1, out: "" }, "bun pm ls -g": { code: 0, out: "" } });
  expect((await updateAgents(run)).lines).toContain("Claude Code: not installed by Fleet, skipped.");
  expect(calls).not.toContain("claude update");
});

test("updates the Claude Code marketplaces and user plugins, and the Codex marketplaces", async () => {
  const { run, calls } = stub({
    "claude plugin marketplace update": { code: 0, out: "" },
    "claude plugin list --json": { code: 0, out: JSON.stringify([{ id: "review@team-tools", scope: "user" }, { id: "local@repo", scope: "project" }, { id: "bad id; rm", scope: "user" }]) },
    "claude plugin update review@team-tools --scope user": { code: 0, out: "" },
    "codex plugin marketplace upgrade": { code: 0, out: "" },
  });
  expect(await updatePlugins(run)).toEqual({ ok: true, lines: ["Claude Code plugins: up to date.", "Codex plugins: up to date."] });
  expect(calls.filter((call) => call.startsWith("claude plugin update"))).toEqual(["claude plugin update review@team-tools --scope user"]);
});

test("skips the plugins of an agent CLI that is missing, and reports a plugin that does not update", async () => {
  const { run } = stub({
    "claude plugin marketplace update": { code: 0, out: "" },
    "claude plugin list --json": { code: 0, out: JSON.stringify([{ id: "review@team-tools", scope: "user" }]) },
    "claude plugin update review@team-tools --scope user": { code: 1, out: "" },
  });
  expect(await updatePlugins(run)).toEqual({ ok: false, lines: ["Claude Code plugins: review@team-tools did not update.", "Codex plugins: codex is not installed, skipped."] });
  const unreadable = stub({ "claude plugin marketplace update": { code: 0, out: "" }, "claude plugin list --json": { code: 0, out: "not json" } });
  expect((await updatePlugins(unreadable.run)).lines[0]).toBe("Claude Code plugins: Fleet could not read the plugin list.");
});

const healthCheck = "curl --fail --silent --max-time 10 --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:3773/.well-known/t3/environment";
const t3Options = (over: Partial<T3Options> = {}): T3Options => ({ busy: () => false, service: true, origin: () => "http://127.0.0.1:3773", ...over });
const healthy = { code: 0, out: JSON.stringify({ environmentId: "env", serverVersion: "0.1.9" }) };

test("while no agent turn runs, compacts T3 Code, moves it to the newest nightly, and checks that its service answers", async () => {
  const { run, calls } = stub({ "t3 --version": { code: 0, out: "t3 v1" }, "t3 doctor --fix": { code: 0, out: "" }, "t3 update --yes --channel nightly": { code: 0, out: "" }, [healthCheck]: healthy });
  expect(await updateT3(run, t3Options())).toEqual({ ok: true, lines: ["T3 Code: up to date, and its service answers."] });
  expect(calls).toEqual(["t3 --version", "t3 doctor --fix", "t3 update --yes --channel nightly", healthCheck]);
});

test("leaves T3 Code alone while an agent turn runs, so the next run tries again", async () => {
  const { run, calls } = stub({ "t3 --version": { code: 0, out: "t3 v1" } });
  expect(await updateT3(run, t3Options({ busy: () => true }))).toEqual({ ok: false, lines: ["T3 Code: an agent turn is running, so the update waits for the next run."] });
  expect(calls).toEqual(["t3 --version"]);
});

test("reports a T3 Code service that does not answer after the update", async () => {
  for (const answer of [{ code: 7, out: "" }, { code: 0, out: "{}" }]) {
    const { run } = stub({ "t3 --version": { code: 0, out: "t3 v1" }, "t3 doctor --fix": { code: 0, out: "" }, "t3 update --yes --channel nightly": { code: 0, out: "" }, [healthCheck]: answer });
    expect(await updateT3(run, t3Options())).toEqual({ ok: false, lines: ["T3 Code: updated, but its service at http://127.0.0.1:3773 does not answer. Run t3 service status."] });
  }
});

test("without a T3 Code service, only updates the CLI; without the CLI, skips T3 Code", async () => {
  const cli = stub({ "t3 --version": { code: 0, out: "t3 v1" }, "t3 update --yes --channel nightly": { code: 0, out: "" } });
  expect(await updateT3(cli.run, t3Options({ service: false }))).toEqual({ ok: true, lines: ["T3 Code: up to date."] });
  expect(cli.calls).toEqual(["t3 --version", "t3 update --yes --channel nightly"]);
  const none = stub({});
  expect(await updateT3(none.run, t3Options())).toEqual({ ok: true, lines: ["T3 Code: not installed, skipped."] });
});

test("a failed compaction or update fails the run", async () => {
  const { run } = stub({ "t3 --version": { code: 0, out: "t3 v1" }, "t3 doctor --fix": { code: 1, out: "" }, "t3 update --yes --channel nightly": { code: 2, out: "" } });
  expect(await updateT3(run, t3Options())).toEqual({ ok: false, lines: ["T3 Code: t3 doctor --fix failed (exit 1).", "T3 Code: t3 update failed (exit 2)."] });
});

test("an agent turn counts as running from T3 Code's state, and a state Fleet cannot read counts as busy", () => {
  const dir = temp.make("t3-state-");
  const state = join(dir, "statev2.sqlite");
  expect(t3Busy(state)).toBe(false);
  const db = new Database(state);
  db.run("create table orchestration_v2_projection_runs (thread_id text, status text)");
  db.run("insert into orchestration_v2_projection_runs values ('a', 'completed'), ('b', 'interrupted')");
  expect(t3Busy(state)).toBe(false);
  for (const status of ["preparing", "starting", "running"]) {
    db.run("delete from orchestration_v2_projection_runs where thread_id = 'c'");
    db.run("insert into orchestration_v2_projection_runs values ('c', ?)", [status]);
    expect(t3Busy(state)).toBe(true);
  }
  db.close();
  const legacy = join(dir, "state.sqlite");
  const old = new Database(legacy);
  old.run("create table projection_thread_sessions (thread_id text, status text)");
  old.run("insert into projection_thread_sessions values ('a', 'running')");
  old.close();
  expect(t3Busy(legacy)).toBe(true);
  writeFileSync(join(dir, "broken.sqlite"), "not a database");
  expect(t3Busy(join(dir, "broken.sqlite"))).toBe(true);
});
