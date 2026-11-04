import { homedir } from "node:os";
import { diskCommand, diskFloorGigabytes, freeBytes } from "../lib/disk.ts";
import { runCommand } from "../lib/command.ts";

await runCommand(() => diskCommand(Bun.argv.slice(2), freeBytes(homedir()), diskFloorGigabytes()));
