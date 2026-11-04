import { homedir } from "node:os";
import { proofCommand } from "../lib/proof-cli.ts";

try {
  process.exitCode = await proofCommand(Bun.argv.slice(2), { home: Bun.env.HOME ?? homedir(), cwd: process.cwd(), env: Bun.env, print: (text) => console.log(text) });
} catch (error) {
  console.error(Bun.env.FLEET_DEBUG ? (error as Error).stack : `fleet: ${(error as Error).message}`);
  process.exitCode = 1;
}
