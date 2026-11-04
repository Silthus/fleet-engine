import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { rolloutLogSetting, runLessons } from "../lib/lessons.ts";
import { mapTracker } from "../lib/tracker.ts";
import { trackerSetting } from "../lib/wayfinder.ts";

await runCommand(() => runLessons(Bun.argv.slice(2), {
  home: homedir(), host: hostname(), print: (line) => console.log(line),
  tracker: () => mapTracker(optionalStringSetting(trackerSetting), Bun.env.FLEET_PROFILE_DIR), rolloutLog: () => stringSetting(rolloutLogSetting),
}));
