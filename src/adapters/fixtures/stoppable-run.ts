import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnRunner } from "../run.ts";

const [ready, gone] = process.argv.slice(2);
const started = join(dirname(ready!), "started");
if (Bun.spawnSync(["mkfifo", started]).exitCode !== 0) throw new Error("mkfifo failed");
const running = spawnRunner(["sh", "-c", '{ sleep 30 & } 3>"$1"; echo $! > "$0"; wait', started, gone!], { signal: new AbortController().signal });
await writeFile(ready!, await readFile(started, "utf8"));
await running;
console.log("the command ended, and this process kept running");
