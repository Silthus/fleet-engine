import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inside } from "../files/install.ts";
import { writePrivateFile } from "../files/private.ts";

/** A step with an undo that held on this machine, as it was when it last applied, so Fleet can undo it after it leaves the plan. */
export type LedgerStep = { pack: string; id: string; check: string[]; undo: string[]; after?: string; prerequisite?: string[] };

const ledgerPath = ".local/state/fleet/steps.json";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");

export const ledgerKey = (step: { pack: string; id: string }) => `${step.pack}/${step.id}`;

export async function readLedger(home: string): Promise<LedgerStep[]> {
  let text: string;
  try {
    text = await readFile(inside(home, ledgerPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const value = JSON.parse(text) as { version?: unknown; steps?: unknown };
  const valid = (step: Partial<LedgerStep>) =>
    typeof step.pack === "string" && typeof step.id === "string" && isStrings(step.check) && isStrings(step.undo) && (step.after === undefined || typeof step.after === "string") && (step.prerequisite === undefined || isStrings(step.prerequisite));
  if (value.version !== 1 || !Array.isArray(value.steps) || !value.steps.every((step) => step && typeof step === "object" && valid(step))) throw new Error(`${ledgerPath} is not a Fleet step ledger`);
  return value.steps as LedgerStep[];
}

export async function writeLedger(home: string, steps: LedgerStep[]) {
  const path = inside(home, ledgerPath);
  await mkdir(dirname(path), { recursive: true });
  await writePrivateFile(path, JSON.stringify({ version: 1, steps: [...steps].sort((a, b) => ledgerKey(a).localeCompare(ledgerKey(b))) }, null, 2) + "\n");
}
