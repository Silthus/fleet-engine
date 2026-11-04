import { join } from "node:path";

export const proofLedgerRoot = (home: string) => join(home, ".local/state/fleet/proof");
export const missesPath = (home: string) => join(proofLedgerRoot(home), "misses.jsonl");
