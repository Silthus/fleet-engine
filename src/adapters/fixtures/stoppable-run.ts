import { spawnRunner } from "../run.ts";

const [ready, gone] = process.argv.slice(2);
await spawnRunner(["sh", "-c", '{ sleep 30 & } 3>"$1"; echo $! > "$0"; wait', ready!, gone!], { signal: new AbortController().signal });
console.log("the command ended, and this process kept running");
