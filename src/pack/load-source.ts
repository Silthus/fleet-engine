import { loadPacks } from "./manifest.ts";

try {
  await loadPacks(process.argv[2]!);
} catch (error) {
  console.error((error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " "));
  process.exit(1);
}
process.exit(0);
