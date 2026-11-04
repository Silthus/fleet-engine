import { runCommand } from "../../base/lib/command.ts";
import { optionalStringSetting } from "../../base/lib/settings.ts";
import { runFrontier } from "../lib/frontier.ts";
import { mapTracker } from "../lib/tracker.ts";
import { trackerSetting } from "../lib/wayfinder.ts";

await runCommand(() => runFrontier(Bun.argv.slice(2), { tracker: () => mapTracker(optionalStringSetting(trackerSetting), Bun.env.FLEET_PROFILE_DIR), print: (line) => console.log(line) }));
