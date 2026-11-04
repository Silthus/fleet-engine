import { expect, test } from "bun:test";
import { updateAgents, type Run } from "./agent-update.ts";

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
    "claude --version": { code: 0, out: "2.1.0" },
    "claude update": { code: 0, out: "" },
    "bun pm ls -g": { code: 0, out: "├── @openai/codex@0.9.0" },
    "bun add -g @openai/codex@latest": { code: 0, out: "" },
  });
  expect(await updateAgents(run)).toEqual({ ok: true, lines: ["Claude Code: up to date.", "Codex: up to date."] });
  expect(calls).toContain("bun add -g @openai/codex@latest");
});

test("skips a CLI that is missing and reports a failed update", async () => {
  const { run, calls } = stub({ "claude --version": { code: 0, out: "2.1.0" }, "claude update": { code: 1, out: "" }, "bun pm ls -g": { code: 0, out: "typescript" } });
  expect(await updateAgents(run)).toEqual({ ok: false, lines: ["Claude Code: update failed (exit 1).", "Codex: not installed by Fleet, skipped."] });
  expect(calls).not.toContain("bun add -g @openai/codex@latest");
});
