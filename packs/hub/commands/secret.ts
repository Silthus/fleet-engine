import { homedir } from "node:os";
import { secretCommand } from "../lib/secret-cli.ts";
import { failureOf } from "../lib/secret-store.ts";

try {
  process.exitCode = await secretCommand(Bun.argv.slice(2), {
    home: Bun.env.HOME ?? homedir(),
    env: Bun.env,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
} catch (error) {
  console.error(`fleet secret: ${failureOf(error)}`);
  process.exitCode = 1;
}
