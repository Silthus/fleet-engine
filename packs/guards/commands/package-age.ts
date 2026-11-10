import { homedir } from "node:os";
import { packageAgeCommand } from "../lib/package-age.ts";

try {
  process.exit(packageAgeCommand(Bun.argv.slice(2), { home: Bun.env.HOME ?? homedir(), platform: process.platform, xdgConfigHome: Bun.env.XDG_CONFIG_HOME, print: (line) => console.log(line) }));
} catch (error) {
  console.error(`fleet package-age: ${(error as Error).message}`);
  process.exit(1);
}
