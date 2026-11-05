import { runCommand } from "../lib/command.ts";
import { codexInstaller } from "./agent-update.ts";

await runCommand(() => Bun.spawn(["sh", codexInstaller], { stdio: ["inherit", "inherit", "inherit"] }).exited);
