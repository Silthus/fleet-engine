import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { stringSetting } from "../../base/lib/settings.ts";
import { rolloutLogSetting, runLessons } from "../lib/lessons.ts";
import { trackerSetting } from "../lib/wayfinder.ts";

await runCommand(() => runLessons(Bun.argv.slice(2), {
  home: homedir(), host: hostname(), print: (line) => console.log(line),
  tracker: () => stringSetting(trackerSetting), rolloutLog: () => stringSetting(rolloutLogSetting),
}));
