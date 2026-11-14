import { serve } from "./server.ts";

const library = process.env.FLEET_CONTEXT_LIBRARY;
if (!library) {
  process.stderr.write("Set FLEET_CONTEXT_LIBRARY to the library folder.\n");
  process.exit(2);
}
await serve(
  { library, url: process.env.FLEET_CONTEXT_URL || undefined },
  process.stdin,
  (line) => process.stdout.write(`${line}\n`),
);
