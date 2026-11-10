import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { runThread } from "../lib/thread.ts";

await runCommand(() => runThread(Bun.argv.slice(2), { home: homedir(), host: hostname(), print: (line) => console.log(line), readStdin: () => Bun.stdin.text() }));
