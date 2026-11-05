import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Result } from "./coder.ts";
import type { CommandCoder } from "./box-command.ts";
import { readBoxSettings, type Machine } from "./machine.ts";

export const boxSettings = {
  "hub.alias": "my-hub", "hub.coderUrl": "https://coder.example.com", "hub.boxTemplate": "linux-box", "hub.boxDiskGigabytes": 120,
  "hub.boxPoolSize": 4, "hub.boxIdleHours": 4, "hub.boxReapDays": 3, "hub.boxKeepDirs": "notes  tools", "hub.relayPort": 60001,
};

export const ok: Result = { code: 0, stdout: "", stderr: "" };
export const start = Date.parse("2026-11-01T00:00:00Z");

export function fakeMachine(home: string, fields: Partial<Machine> = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  let now = start;
  const machine: Machine = {
    home,
    self: "devbox-1",
    workspace: "devbox-1",
    isHub: false,
    peers: ["my-hub", "devbox-2"],
    devboxes: ["devbox-1", "devbox-2"],
    codex: false,
    settings: readBoxSettings({ FLEET_SETTINGS: JSON.stringify(boxSettings) }),
    onPeer: (alias, command) => {
      calls.push(`peer ${alias}: ${command}`);
      return ok;
    },
    run: (argv) => {
      calls.push(`run ${argv.join(" ")}`);
      return ok;
    },
    now: () => now,
    sleep: async (ms) => void (now += ms),
    freePort: () => 21000,
    environmentId: async () => "env-box",
    linkEnvironment: async (input) => void calls.push(`link ${[input.url, ...input.alternateUrls].join(" ")} with ${input.access} access`),
    print: (line) => lines.push(line),
    say: (line) => lines.push(line),
    ...fields,
  };
  return { machine, calls, lines };
}

export const box = (name: string, status = "running", fields: { id?: string; template?: string; lastUsedAt?: string } = {}) =>
  ({ name, id: `ws-${name}`, template: "linux-box", status, lastUsedAt: "2026-10-28T07:00:00Z", ...fields });

export function writePool(home: string, pool: { free?: string[]; refreshing?: string[]; boxes: Record<string, { id: string; claim?: string; holding?: string }> }) {
  writeHome(home, { ".config/fleet/box-pool.json": JSON.stringify({ free: [], refreshing: [], ...pool }) });
}

export type SshCall = { box: string; command: string; stdin?: string };

export function fakeCoder(fields: Partial<CommandCoder> = {}) {
  const calls: SshCall[] = [];
  const done: string[] = [];
  const coder: CommandCoder = {
    binary: "coder",
    env: {},
    token: () => "[]",
    boxes: () => [box("box-lane")],
    ssh: (box, command, stdin) => {
      calls.push({ box, command, ...(stdin === undefined ? {} : { stdin }) });
      return ok;
    },
    sshLater: async (box, command) => {
      calls.push({ box, command });
      return ok;
    },
    sshAfterStartup: () => ok,
    remove: (box) => void done.push(`remove ${box}`),
    stop: (box) => void done.push(`stop ${box}`),
    extend: (box, duration) => void done.push(`extend ${box} ${duration}`),
    start: async (box) => void done.push(`start ${box}`),
    create: async (name, from, disk) => (done.push(`create ${name} from ${from} with ${disk} GB`), `ws-${name}`),
    run: () => 0,
    ...fields,
  };
  return { coder, calls, done };
}

export function writeHome(home: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(home, path, ".."), { recursive: true });
    writeFileSync(join(home, path), content);
  }
}

export function stubBin(dir: string, names: string[]) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${join(dir, "calls.log")}"\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

export function linkedHere(home: string, environmentId = "env-1") {
  writeHome(home, { ".config/fleet/boxes/box-lane.json": JSON.stringify({ environmentId, port: 21000 }) });
  return join(home, ".config/fleet/boxes/box-lane.json");
}
