import { homedir, hostname } from "node:os";
import { runCommand } from "../../base/lib/command.ts";
import { modelFor } from "../../base/lib/models.ts";
import { optionalStringSetting, stringSetting } from "../../base/lib/settings.ts";
import { launchScratchThread, withT3Session } from "../../base/lib/t3/index.ts";
import { capture, Coder } from "../lib/coder.ts";
import { knownDevboxes, quote, shellLimitMs } from "../lib/machine.ts";
import { modelAnalyst } from "../lib/dream/analyze.ts";
import { boundedSpawn } from "../lib/dream/spawn.ts";
import { dreamCommand, dreamPeers } from "../lib/dream/command.ts";

const home = homedir();
const env = Bun.env;

function boxes() {
  const coderUrl = optionalStringSetting("hub.coderUrl", env);
  const template = optionalStringSetting("hub.boxTemplate", env);
  if (!coderUrl || !template) return undefined;
  const coder = new Coder({ home, env, coderUrl, template });
  return { running: async () => (await coder.boxes(30_000)).filter((box) => box.status === "running").map((box) => box.name), ssh: (box: string, command: string) => coder.ssh(box, command, undefined, 120_000) };
}

await runCommand(() => dreamCommand(Bun.argv.slice(2), {
  home,
  env,
  self: env.CODER_WORKSPACE_NAME ?? hostname(),
  now: Date.now,
  print: (text) => void process.stdout.write(text.endsWith("\n") || !text ? text : `${text}\n`),
  say: (line) => console.error(line),
  peers: () => dreamPeers(stringSetting("hub.alias", env), knownDevboxes(env, home), hostname()),
  onPeer: (alias, command) => capture(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", alias, `bash -lc ${quote(command)}`], { timeoutMs: shellLimitMs }),
  boxes,
  git: (args) => capture(["git", ...args], { timeoutMs: shellLimitMs }),
  analyst: () => modelAnalyst(modelFor("lookup", env), home, env, boundedSpawn()),
  launch: (title, prompt) => withT3Session((client) => launchScratchThread(client, { title, prompt, row: modelFor("implementation", env) }), { home, access: "write" }),
}), "fleet dream");
