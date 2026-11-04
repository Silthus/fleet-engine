import { homedir } from "node:os";
import { runCommand } from "../lib/command.ts";
import { diskFloorGigabytes } from "../lib/disk.ts";
import { prune, pruneAuto, pruneOptions } from "../lib/prune.ts";

await runCommand(() => {
  const home = homedir();
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const { options, auto } = pruneOptions(Bun.argv.slice(2), log, { home, env: Bun.env, floorGigabytes: diskFloorGigabytes() });
  const verdicts = auto ? pruneAuto(options, auto, home) : prune(options);
  return verdicts.some((verdict) => verdict.reason.startsWith("removal failed")) ? 1 : 0;
});
