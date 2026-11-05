import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../base/lib/command.ts";
import { numberSetting, optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { lineWriter } from "../lib/mcphub/bridge.ts";
import { runMcphub } from "../lib/mcphub/command.ts";

async function run(command: string[], options: { cwd?: string; input?: string } = {}) {
  const child = Bun.spawn(command, { cwd: options.cwd, stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

async function devboxes() {
  const profile = Bun.env.FLEET_PROFILE_DIR;
  if (!profile) throw new Error("run this command as fleet mcphub, so it finds your profile");
  return ((JSON.parse(await readFile(join(profile, "fleet.json"), "utf8")) as { devboxes?: string[] }).devboxes ?? []);
}

await runCommand(() => runMcphub(Bun.argv.slice(2), {
  home: homedir(),
  root: join(import.meta.dir, ".."),
  platform: process.platform,
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
  alias: () => stringSetting("hub.alias"),
  devboxes,
  gateway: { httpsHost: optionalStringSetting("hub.httpsHost"), relayPort: numberSetting("hub.relayPort") },
  run,
  fetch,
  sleep: (ms) => Bun.sleep(ms),
  print: (line) => console.log(line),
  write: lineWriter(process.stdout),
  fail: (line) => console.error(line),
  stdin: Bun.stdin.stream(),
}), "fleet mcphub");
