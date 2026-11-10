import { loadPacks } from "./manifest.ts";

try {
  await loadPacks(process.argv[2]!);
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
process.exit(0);
