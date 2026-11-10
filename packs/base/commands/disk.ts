import { homedir, hostname } from "node:os";
import { diskCommand, diskFloorGigabytes, freeBytes, readFreeMap, thisMachine } from "../lib/disk.ts";
import { runCommand } from "../lib/command.ts";

const home = homedir();
const place = { ...thisMachine(home, hostname()), freeMap: () => readFreeMap(home), now: Date.now() };
await runCommand(() => diskCommand(Bun.argv.slice(2), freeBytes(home), diskFloorGigabytes(), place));
