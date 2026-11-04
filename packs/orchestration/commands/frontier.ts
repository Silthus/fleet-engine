import { runCommand } from "../../base/lib/command.ts";
import { stringSetting } from "../../base/lib/settings.ts";
import { runFrontier } from "../lib/frontier.ts";
import { trackerSetting } from "../lib/wayfinder.ts";

await runCommand(() => runFrontier(Bun.argv.slice(2), { tracker: () => stringSetting(trackerSetting), print: (line) => console.log(line) }));
