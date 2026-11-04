import { runCommand } from "../../base/lib/command.ts";
import { stringSetting } from "../../base/lib/settings.ts";
import { runDecisions } from "../lib/decisions.ts";
import { trackerSetting } from "../lib/wayfinder.ts";

await runCommand(() => runDecisions(Bun.argv.slice(2), { tracker: () => stringSetting(trackerSetting), print: (line) => console.log(line) }));
