import { realMachine } from "../commands.ts";
import { humanStep, packSignIn } from "../human.ts";
import { ttyTerminal } from "../terminal.ts";

const [token] = process.argv.slice(2);
const sleeps: number[] = [];
const machine = { ...realMachine, sleep: async (ms: number) => void sleeps.push(ms) };
const step = { id: "login", pack: "team", say: "Sign in to the team service", command: `read token && printf %s "$token" > '${token}'`, probe: ["test", "-s", token!], interactive: true as const };
const terminal = ttyTerminal();
try {
  await humanStep(packSignIn(step, [], { terminal, machine, nonInteractive: false }, undefined), { terminal, machine, nonInteractive: false }).run();
  terminal.print(`sleeps=${sleeps.length}`);
  process.exit(0);
} catch (error) {
  terminal.print(`failed: ${(error as Error).message}`);
  process.exit(1);
}
