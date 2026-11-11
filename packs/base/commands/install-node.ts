import { join } from "node:path";
import { runCommand } from "../lib/command.ts";

const nodeInstaller = join(import.meta.dir, "../lib/install-node.sh");

await runCommand(() => Bun.spawn(["sh", nodeInstaller], { stdio: ["inherit", "inherit", "inherit"] }).exited);
