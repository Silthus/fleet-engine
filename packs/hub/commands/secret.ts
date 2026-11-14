import { homedir } from "node:os";
import { secretCommand } from "../lib/secret-cli.ts";

try {
  process.exitCode = await secretCommand(Bun.argv.slice(2), {
    home: Bun.env.HOME ?? homedir(),
    env: Bun.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
} catch (error) {
  console.error(Bun.env.FLEET_DEBUG ? (error as Error).stack : `fleet secret: ${(error as Error).message}`);
  process.exitCode = 1;
}
