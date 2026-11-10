import { homedir } from "node:os";
import { runCommand } from "../lib/command.ts";
import { resolvedSettings } from "../lib/settings.ts";
import { settingsSnapshotCommand } from "../lib/settings-snapshot.ts";

await runCommand(() => settingsSnapshotCommand(Bun.argv.slice(2), homedir(), resolvedSettings()), "fleet settings-snapshot");
