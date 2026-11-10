import { allowlistCommand } from "../lib/allowlist-command.ts";

const [group, ...args] = Bun.argv.slice(2);
try {
  if (group !== "allowlist") throw new Error("usage: fleet guards allowlist [text | stage <folder> | --check]");
  process.exit(allowlistCommand(args, { settings: JSON.parse(Bun.env.FLEET_SETTINGS ?? "{}"), profileDir: Bun.env.FLEET_PROFILE_DIR, root: "/", print: (line) => console.log(line) }));
} catch (error) {
  console.error(`fleet guards: ${(error as Error).message}`);
  process.exit(1);
}
