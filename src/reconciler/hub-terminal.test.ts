import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../testing/git.ts";

const temp = tempDirs();
const leftovers: string[] = [];
afterEach(() => {
  for (const pidFile of leftovers.splice(0)) if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
  temp.cleanup();
});

const cli = join(import.meta.dir, "../cli.ts");
const onLinux = test.if(process.platform === "linux");

function node(ssh?: string) {
  const home = temp.make("home-");
  const profile = temp.make("profile-");
  const bin = temp.make("bin-");
  writeFileSync(join(profile, "fleet.json"), JSON.stringify({ schema: 1, engine: { repo: "example/engine", ref: "main", channel: "track" }, sources: [], packs: ["mcp-gateway"], plan: "codex", settings: {}, workflows: {}, hub: "hub-1", devboxes: ["node-2"] }));
  mkdirSync(join(home, ".config/fleet"), { recursive: true });
  writeFileSync(join(home, ".config/fleet/machine.json"), JSON.stringify({ schema: 1, role: "devbox", coder: true, name: "node-2", profileDir: profile }));
  if (ssh) writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho $$ > "$HOME/ssh.pid"\n${ssh}\n`, { mode: 0o755 });
  leftovers.push(join(home, "ssh.pid"), join(home, "held.pid"));
  const env = { HOME: home, PATH: ssh ? `${bin}:/usr/bin:/bin` : bin };
  return { home, env, args: [process.execPath, cli, "mcp-gateway", "doctor"] };
}

onLinux("a hub command typed on a node hands ssh this terminal: its input, its output, its errors, and its exit code", () => {
  const { home, env, args } = node('cat > "$HOME/stdin.txt"; echo "out from hub"; echo "err from hub" >&2; exit 7');
  const ran = Bun.spawnSync(args, { env, stdin: new TextEncoder().encode("typed on the node\n") });
  expect({ code: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() }).toEqual({ code: 7, stdout: "out from hub\n", stderr: "err from hub\n" });
  expect(readFileSync(join(home, "stdin.txt"), "utf8")).toBe("typed on the node\n");
});

onLinux("a hub command passes a stop signal on to ssh and waits for it", async () => {
  const { home, env, args } = node(`trap 'kill $held; echo stopped > "$HOME/stopped"; exit 143' TERM; sleep 600 & held=$!; echo $held > "$HOME/held.pid"; echo ready; wait $held`);
  const fleet = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const reader = fleet.stdout.getReader();
  let seen = "";
  while (!seen.includes("ready\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += new TextDecoder().decode(value);
  }
  fleet.kill("SIGTERM");
  expect(await fleet.exited).toBe(143);
  expect(readFileSync(join(home, "stopped"), "utf8")).toBe("stopped\n");
});

onLinux("a hub command passes on a stop signal that arrives while ssh starts", async () => {
  const { home, env, args } = node(`trap 'kill $! 2>/dev/null; echo stopped > "$HOME/stopped"; exit 143' TERM; kill -TERM $PPID; sleep 600 & wait $!`);
  const fleet = Bun.spawn(args, { env, stdout: "ignore", stderr: "ignore" });
  expect(await fleet.exited).toBe(143);
  expect(readFileSync(join(home, "stopped"), "utf8")).toBe("stopped\n");
});

onLinux("without ssh on this machine, a hub command says it could not start ssh", () => {
  const { env, args } = node();
  const ran = Bun.spawnSync(args, { env });
  expect(ran.exitCode).toBe(127);
  expect(ran.stderr.toString()).toContain("ssh could not start");
});
