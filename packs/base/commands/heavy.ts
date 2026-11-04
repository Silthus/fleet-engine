import { join } from "node:path";
import { runCommand } from "../lib/command.ts";
import { numberSetting } from "../lib/settings.ts";

await runCommand(() => {
  const env = { ...Bun.env, FLEET_HEAVY_SLOTS: String(numberSetting("base.heavySlots")) };
  const script = join(import.meta.dir, "../lib/heavy.sh");
  return Bun.spawn(["sh", script, ...Bun.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"], env }).exited;
});
