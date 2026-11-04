import { homedir } from "node:os";
import { prCommand } from "../lib/pr.ts";

try {
  process.exitCode = await prCommand(Bun.argv.slice(2), Bun.env.HOME ?? homedir());
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(`fleet pr: ${error.message}`);
  process.exitCode = 1;
}
