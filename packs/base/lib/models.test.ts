import { expect, test } from "bun:test";
import { modelFor, modelTable, type ModelRow } from "./models.ts";

const rows: ModelRow[] = [
  { role: "lookup", work: "Find files", provider: "claude", model: "small-model", effort: "medium" },
  { role: "review", work: "Review Claude's code", provider: "codex", model: "large-model", effort: "high" },
];
const env = { FLEET_MODELS: JSON.stringify(rows) };

test("reads the row of a role from the model table of the user's plan", () => {
  expect(modelFor("review", env)).toEqual(rows[1]!);
  expect(modelTable(env)).toEqual(rows);
});

test("refuses a role the table lacks, a missing table, and a malformed row", () => {
  expect(() => modelFor("review-codex", env)).toThrow("the model table of your AI plan has no review-codex row");
  expect(() => modelFor("lookup", {})).toThrow("run this command as fleet <command>, so it gets your model table");
  expect(() => modelTable({ FLEET_MODELS: JSON.stringify([{ ...rows[0], provider: "gemini" }]) })).toThrow("FLEET_MODELS holds a malformed row");
});
