import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { credentialName } from "../../../src/runner/context.ts";
import type { Context } from "../../../src/sdk/index.ts";
import type { Hub, Run } from "./hub.ts";

export const gatewayKey = credentialName("mcp-gateway");

type ProfileFacts = { hub?: string; devboxes?: string[] };

const run: Run = async (command, options = {}) => {
  const child = Bun.spawn(command, { cwd: options.cwd, stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};

async function savedName(home: string) {
  try { return (JSON.parse(await readFile(join(home, ".config/fleet/machine.json"), "utf8")) as { name?: string }).name; }
  catch { return undefined; }
}

/** The gateway's view of this machine: its home, the profile's hub and devboxes, and the tools it runs. The hub is the machine the profile names, or this machine when the profile names none. */
export async function gateway(ctx: Context): Promise<Hub> {
  const home = process.env.HOME!;
  const profileDir = process.env.FLEET_PROFILE_DIR;
  if (!profileDir) throw new Error("run this command through fleet, so it finds your profile");
  const profile = JSON.parse(await readFile(join(profileDir, "fleet.json"), "utf8")) as ProfileFacts;
  const hubName = profile.hub ?? (await savedName(home));
  return {
    home,
    root: join(import.meta.dir, ".."),
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    hubName: () => {
      if (!hubName) throw new Error("your profile names no hub. Run fleet hub here on the machine that should be the hub.");
      return hubName;
    },
    devboxes: async () => profile.devboxes ?? [],
    gateway: {},
    run,
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => ctx.sleep(ms),
    print: (line) => ctx.print(line),
  };
}
