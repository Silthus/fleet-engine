import { chmodSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Box, Result } from "./coder.ts";
import type { CommandCoder } from "./box-command.ts";
import { readBoxSettings, type Machine } from "./machine.ts";
import { poolFile, type Entry } from "./pool.ts";

export const boxSettings = {
  "hub.alias": "my-hub", "hub.coderUrl": "https://coder.example.com", "hub.boxTemplate": "linux-box", "hub.boxDiskGigabytes": 120,
  "hub.boxPoolSize": 4, "hub.boxIdleHours": 4, "hub.boxReapDays": 3, "hub.boxKeepDirs": "notes  tools", "hub.relayPort": 60001,
};

export const ok: Result = { code: 0, stdout: "", stderr: "" };
export const start = Date.parse("2026-11-01T00:00:00Z");

export function fakeMachine(home: string, fields: Partial<Machine> = {}) {
  const calls: string[] = [];
  const toHub: string[][] = [];
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
    onPeer: async (alias, command) => {
      calls.push(`peer ${alias}: ${command}`);
      return ok;
    },
    toHub: async (args) => (toHub.push(args), 0),
    run: async (argv) => {
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
  return { machine, calls, lines, toHub };
}

export const box = (name: string, status = "running", fields: { id?: string; template?: string; lastUsedAt?: string } = {}): Box =>
  ({ name, id: `ws-${name}`, template: "linux-box", status, lastUsedAt: "2026-10-28T07:00:00Z", ...fields });

export function writePool(home: string, pool: { free?: string[]; refreshing?: string[]; boxes: Record<string, Entry> }) {
  writeHome(home, { ".config/fleet/box-pool.json": JSON.stringify({ free: [], ...pool }) });
}

export const registryOf = (home: string) => JSON.parse(readFileSync(poolFile(home), "utf8")) as { free: string[]; boxes: Record<string, Entry> };

export type SshCall = { box: string; command: string; stdin?: string };

export function fakeCoder(fields: Partial<CommandCoder> = {}, listed: Box[] = [box("box-lane")]) {
  const calls: SshCall[] = [];
  const done: string[] = [];
  const named = (id: string) => listed.find((entry) => entry.id === id)?.name ?? id;
  const mark = (id: string, status: string) => {
    const found = listed.find((entry) => entry.id === id);
    if (found) found.status = status;
  };
  const coder: CommandCoder = {
    binary: async () => "coder",
    env: {},
    token: async () => "[]",
    sessionFrom: "none",
    sessionKey: async () => undefined,
    boxes: async () => listed.map((entry) => ({ ...entry })),
    ssh: async (box, command, stdin) => {
      calls.push({ box, command, ...(stdin === undefined ? {} : { stdin }) });
      return ok;
    },
    sshAfterStartup: async () => ok,
    remove: async (id) => {
      done.push(`remove ${named(id)}`);
      const index = listed.findIndex((entry) => entry.id === id);
      if (index >= 0) listed.splice(index, 1);
    },
    stop: async (id) => {
      done.push(`stop ${named(id)}`);
      mark(id, "stopped");
    },
    extend: async (id, deadline) => void done.push(`extend ${named(id)} until ${deadline}`),
    start: async (id) => {
      done.push(`start ${named(id)}`);
      mark(id, "running");
    },
    create: async (name, from, disk) => {
      done.push(`create ${name} from ${from} with ${disk} GB`);
      listed.push(box(name));
      return `ws-${name}`;
    },
    run: async () => 0,
    ...fields,
  };
  return { coder, calls, done, listed };
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

export function appeared(path: string): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    };
    const watcher = watch(dirname(path), done);
    done();
  });
}
