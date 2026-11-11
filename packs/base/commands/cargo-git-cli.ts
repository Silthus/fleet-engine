import { homedir } from "node:os";
import { cargoGitCliCommand } from "../lib/cargo-git-cli.ts";
import { runCommand } from "../lib/command.ts";

await runCommand(() => cargoGitCliCommand(Bun.argv.slice(2), homedir(), console.log), "fleet cargo-git-cli");
