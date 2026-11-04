import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";
import { engineShellCommand } from "./engine-command.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());

describe("engineShellCommand", () => {
  test.each(["match$&engine", "two$$dollars", "quote's"])("runs the launcher of an engine at a path holding %s", (name) => {
    const root = join(temp.make("engine-"), name);
    mkdirSync(root);
    writeFileSync(join(root, "fleet"), 'printf "%s" "$*"\n');
    const shell = Bun.spawnSync(["sh", "-c", engineShellCommand("fleet login --web", root)]);
    expect({ code: shell.exitCode, output: shell.stdout.toString() }).toEqual({ code: 0, output: "login --web" });
  });
});
