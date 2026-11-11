import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checkParents, inside } from "../files/install.ts";
import { writePrivateFile } from "../files/private.ts";

/** A step with an undo that held on this machine, as it was when it last applied, so Fleet can undo it after it leaves the plan. */
export type LedgerStep = { pack: string; id: string; check: string[]; undo: string[]; after?: string; prerequisite?: string[] };

/** A human step with an undo text whose probe passed on this machine, so doctor can say what a person removes after it leaves the plan. */
export type LedgerHuman = { pack: string; id: string; probe: string[]; undo: string };
export type Ledger = { steps: LedgerStep[]; human: LedgerHuman[] };

const ledgerPath = ".local/state/fleet/steps.json";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");

export const ledgerKey = (step: { pack: string; id: string }) => `${step.pack}/${step.id}`;

export const undoVariable = "FLEET_UNDO";

/** The pack whose command line this is, when it is the undo, check or prerequisite of the ledger step that FLEET_UNDO names, or the probe of its human step. */
export async function undoingPack(home: string, env: Record<string, string | undefined>, command: string[]): Promise<string | undefined> {
  const key = env[undoVariable];
  if (!key) return undefined;
  const ledger = await readLedger(home);
  const same = (line: string[] | undefined) => line?.length === command.length && line.every((part, index) => part === command[index]);
  const step = ledger.steps.find((item) => ledgerKey(item) === key);
  if (step && [step.undo, step.check, step.prerequisite].some(same)) return step.pack;
  const human = ledger.human.find((item) => ledgerKey(item) === key);
  return human && same(human.probe) ? human.pack : undefined;
}

export async function readLedger(home: string): Promise<Ledger> {
  await checkParents(home, ledgerPath);
  const path = inside(home, ledgerPath);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return { steps: [], human: [] };
  if (!info.isFile()) throw new Error(`${ledgerPath} must be a regular file`);
  const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; steps?: unknown; human?: unknown };
  const valid = (step: Partial<LedgerStep>) =>
    typeof step.pack === "string" && typeof step.id === "string" && isStrings(step.check) && isStrings(step.undo) && (step.after === undefined || typeof step.after === "string") && (step.prerequisite === undefined || isStrings(step.prerequisite));
  const validHuman = (step: Partial<LedgerHuman>) => typeof step.pack === "string" && typeof step.id === "string" && isStrings(step.probe) && typeof step.undo === "string";
  const human = value.human ?? [];
  const records = (list: unknown, check: (item: never) => boolean) => Array.isArray(list) && list.every((item) => item && typeof item === "object" && check(item as never));
  if (value.version !== 1 || !records(value.steps, valid) || !records(human, validHuman)) throw new Error(`${ledgerPath} is not a Fleet step ledger`);
  return { steps: value.steps as LedgerStep[], human: human as LedgerHuman[] };
}

const sorted = <T extends { pack: string; id: string }>(items: T[]) => [...items].sort((a, b) => ledgerKey(a).localeCompare(ledgerKey(b)));

/** Records or forgets one entry in the ledger as it is on disk now, so another apply's entries survive and each step is kept as soon as it holds. */
export async function changeLedger<List extends keyof Ledger>(home: string, list: List, key: string, entry?: Ledger[List][number]) {
  const ledger = await readLedger(home);
  const kept = (ledger[list] as Array<{ pack: string; id: string }>).filter((item) => ledgerKey(item) !== key);
  const next = { ...ledger, [list]: entry ? [...kept, entry] : kept };
  const text = (value: Ledger) => JSON.stringify({ version: 1, steps: sorted(value.steps), human: sorted(value.human) }, null, 2) + "\n";
  if (text(next) === text(ledger)) return;
  const path = inside(home, ledgerPath);
  await mkdir(dirname(path), { recursive: true });
  await writePrivateFile(path, text(next));
}
