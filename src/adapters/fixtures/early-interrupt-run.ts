import { spawnRunner } from "../run.ts";

const [held] = process.argv.slice(2);
await spawnRunner(["sh", "-c", 'exec 3>"$0"; echo $$ >&3; kill -TERM $PPID; sleep 600 & wait $!', held!], { signal: new AbortController().signal });
console.log("the command ended, and this process kept running");
