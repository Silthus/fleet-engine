import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { gitEnv } from "../../../../src/testing/git.ts";
import { writeHome } from "../testing.ts";
import type { DreamIo } from "./command.ts";

export const dreamNow = Date.parse("2026-11-05T04:10:00Z");
export const dreamSettings = { "hub.alias": "my-hub", "hub.dreamSessions": 150, "memory.repo": "me/notes", "memory.subtree": "memory" };

export function note(name: string, fields: Record<string, string> = {}, body = "A fact.") {
  const extra = Object.entries(fields).map(([key, value]) => `${key}: ${value}\n`).join("");
  return `---\nname: ${name}\ndescription: about ${name}\nmetadata:\n  type: project\n${extra}---\n${body}\n`;
}

export function hubWithSubtree(home: string, files: Record<string, string> = {}) {
  const prefixed = Object.fromEntries(Object.entries(files).map(([path, text]) => [`.agents/memory-repo/memory/${path}`, text]));
  writeHome(home, { ".config/fleet/machine.json": JSON.stringify({ schema: 1, role: "hub" }), ".agents/memory-repo/README.md": "# Notes\n", ...prefixed });
  symlinkSync(join(home, ".agents/memory-repo/memory"), join(home, ".agents/memory"));
}

export async function realGit(args: string[]) {
  const child = Bun.spawn(["git", ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

export function quietIo(home: string, fields: Partial<DreamIo> = {}) {
  const printed: string[] = [];
  const said: string[] = [];
  const offline = () => { throw new Error("this command reaches no other machine and asks no model"); };
  const io: DreamIo = {
    home, env: { FLEET_SETTINGS: JSON.stringify(dreamSettings) }, self: "hub-host", now: () => dreamNow,
    print: (text) => void printed.push(text), say: (text) => void said.push(text),
    peers: () => [], onPeer: offline, boxes: () => undefined, git: offline, analyst: offline, checker: offline, launch: offline,
    ...fields,
  };
  return { io, printed, said };
}
