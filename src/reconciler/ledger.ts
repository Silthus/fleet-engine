import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { checkParents, inside } from "../files/install.ts";
import { writePrivateFile } from "../files/private.ts";

/** A step with an undo that held on this machine, as it was when it last applied, so Fleet can undo it after it leaves the plan. */
export type LedgerStep = { pack: string; id: string; check: string[]; undo: string[]; after?: string; prerequisite?: string[] };

const ledgerPath = ".local/state/fleet/steps.json";
const lockPath = ".local/state/fleet/steps.lock";
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");

export const ledgerKey = (step: { pack: string; id: string }) => `${step.pack}/${step.id}`;

export async function readLedger(home: string): Promise<LedgerStep[]> {
  await checkParents(home, ledgerPath);
  const path = inside(home, ledgerPath);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return [];
  if (!info.isFile()) throw new Error(`${ledgerPath} must be a regular file`);
  const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; steps?: unknown };
  const valid = (step: Partial<LedgerStep>) =>
    typeof step.pack === "string" && typeof step.id === "string" && isStrings(step.check) && isStrings(step.undo) && (step.after === undefined || typeof step.after === "string") && (step.prerequisite === undefined || isStrings(step.prerequisite));
  if (value.version !== 1 || !Array.isArray(value.steps) || !value.steps.every((step) => step && typeof step === "object" && valid(step))) throw new Error(`${ledgerPath} is not a Fleet step ledger`);
  return value.steps as LedgerStep[];
}

let queue: Promise<unknown> = Promise.resolve();

/** Records or forgets one step in the ledger as it is on disk now, under a lock, so another apply's entries survive and each step is kept as soon as it holds. */
export function changeLedger(home: string, key: string, step?: LedgerStep): Promise<void> {
  const change = queue.then(() => locked(home, () => rewrite(home, key, step)));
  queue = change.catch(() => undefined);
  return change;
}

async function rewrite(home: string, key: string, step?: LedgerStep) {
  const steps = await readLedger(home);
  const kept = steps.filter((item) => ledgerKey(item) !== key);
  const next = step ? [...kept, step] : kept;
  const sorted = next.sort((a, b) => ledgerKey(a).localeCompare(ledgerKey(b)));
  if (JSON.stringify(sorted) === JSON.stringify([...steps].sort((a, b) => ledgerKey(a).localeCompare(ledgerKey(b))))) return;
  await writePrivateFile(inside(home, ledgerPath), JSON.stringify({ version: 1, steps: sorted }, null, 2) + "\n");
}

const lockWaits = 400;

/** Holds the ledger's lock while work runs. Another Fleet process holds it only for one read and write, so this waits a little for it, and names it when it stays. */
async function locked<T>(home: string, work: () => Promise<T>): Promise<T> {
  await checkParents(home, lockPath);
  const lock = inside(home, lockPath);
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  for (let wait = 0; ; wait++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (wait === lockWaits) throw new Error(`Another Fleet apply holds ${lock}. Remove it only if that apply has stopped.`);
      await Bun.sleep(5);
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
