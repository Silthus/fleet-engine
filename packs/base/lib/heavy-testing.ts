import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "../../../src/testing/git.ts";

export const temp = tempDirs();

const systemdRun = `const args = Bun.argv.slice(2);
const split = args.indexOf("--");
const setenv = args.slice(0, split).filter((option) => option.startsWith("--setenv=")).map((option) => option.slice("--setenv=".length));
const given = Object.fromEntries(setenv.map((pair) => (pair.includes("=") ? [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] : [pair, Bun.env[pair] ?? ""])));
const manager = { HOME: "/home/manager", PATH: "/usr/bin:/bin" };
const env = args.includes("--scope") ? Bun.env : { ...manager, ...given };
process.exit(Bun.spawnSync(args.slice(split + 1), { env, stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1);
`;

export function stubs(os = "Linux") {
  const bin = temp.make("bin-");
  const calls = join(bin, "calls.log");
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  writeFileSync(join(bin, "systemd-run.ts"), systemdRun);
  stub("systemd-run", `case " $* " in *" --scope "*) while [ "$1" != -- ]; do shift; done; shift; exec "$@" ;; esac\nexec bun "${join(bin, "systemd-run.ts")}" "$@"`);
  stub("systemctl", "exit 0");
  stub("uname", `echo ${os}`);
  return { bin, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "") };
}

export async function heavy(bin: string, settings: Record<string, unknown>, ...args: string[]) {
  return heavyWith({}, bin, settings, ...args);
}

export async function heavyWith(extra: Record<string, string>, bin: string, settings: Record<string, unknown>, ...args: string[]) {
  const home = temp.make("home-");
  const { FLEET_HEAVY_SLOTS: _, ...inherited } = Bun.env;
  const env = { ...inherited, HOME: home, XDG_RUNTIME_DIR: home, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify(settings), ...extra };
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../commands/heavy.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}

export const roomy = { "base.heavySlots": 2, "base.diskFloorGigabytes": 0 };

function follow(stream: ReadableStream<Uint8Array>) {
  let text = "";
  let ended = false;
  const waiting: Array<() => void> = [];
  const wake = () => waiting.splice(0).forEach((resume) => resume());
  void (async () => {
    for await (const chunk of stream) {
      text += new TextDecoder().decode(chunk);
      wake();
    }
    ended = true;
    wake();
  })();
  return {
    text: () => text,
    until: async (part: string) => {
      while (!text.includes(part)) {
        if (ended) throw new Error(`the stream ended before "${part}": ${text}`);
        await new Promise<void>((resume) => waiting.push(resume));
      }
    },
  };
}

export function machine(slots = 1) {
  const { bin } = stubs();
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "sleep"), 0o755);
  const home = temp.make("home-");
  const tmp = temp.make("tmp-");
  const folder = temp.make("work-");
  const started: Array<ReturnType<typeof Bun.spawn>> = [];
  const { FLEET_HEAVY_SLOTS: _, T3CODE_THREAD_ID: __, ...inherited } = Bun.env;
  const env = (extra: Record<string, string>) => ({ ...inherited, HOME: home, XDG_RUNTIME_DIR: home, TMPDIR: tmp, PATH: `${bin}:${Bun.env.PATH}`, FLEET_SETTINGS: JSON.stringify(roomy), FLEET_HEAVY_SLOTS: String(slots), ...extra });
  const start = (args: string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../commands/heavy.ts"), ...args], { cwd: folder, env: env(extra), stdout: "pipe", stderr: "pipe", detached: true });
    started.push(child);
    return { child, out: follow(child.stdout), err: follow(child.stderr) };
  };
  const holders = async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../commands/heavy.ts"), "--holders"], { cwd: folder, env: env({}), stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return stdout;
  };
  const stopAll = async () => {
    for (const child of started) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    await Promise.all(started.map((child) => child.exited));
  };
  return { bin, home, tmp, folder, start, holders, stopAll };
}
