import { spawn } from "node:child_process";
import { platform } from "node:os";

export type ExecResult = { code: number; output: string };
export type Exec = (command: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;
/** A command running in the background: stop ends it and everything it started, and exited gives its exit code, 127 when it could not start. */
export type Started = { stop(): void; exited: Promise<number> };

/** What setup needs from the machine: commands, a clock, and a browser. Tests replace each one. */
export type Machine = {
  exec: Exec;
  /** Starts a sign-in command in the background, its output shown in the terminal. */
  start(command: string[]): Started;
  /** Runs a command in the foreground with its output in the terminal, and the keyboard too when it needs input. */
  run(command: string[], options?: { input?: boolean }): Promise<number>;
  sleep(ms: number): Promise<void>;
  openUrl(url: string): Promise<void>;
  has(tool: string): boolean;
};

export const realMachine: Machine = {
  async exec(command, options = {}) {
    try {
      const child = Bun.spawn(command, { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: options.timeoutMs });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, output: `${stdout}${stderr}` };
    } catch {
      return { code: 127, output: "" };
    }
  },
  start(command) {
    const child = spawn(command[0]!, command.slice(1), { stdio: ["ignore", "inherit", "inherit"], detached: true });
    const exited = new Promise<number>((resolve) => {
      child.once("error", () => resolve(127));
      child.once("exit", (code) => resolve(code ?? 1));
    });
    let running = true;
    void exited.then(() => (running = false));
    const stop = () => {
      if (!running || child.pid === undefined) return;
      running = false;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    };
    process.once("exit", stop);
    void exited.then(() => process.off("exit", stop));
    return { stop, exited };
  },
  async run(command, options = {}) {
    try {
      return await Bun.spawn(command, { stdin: options.input ? "inherit" : "ignore", stdout: "inherit", stderr: "inherit" }).exited;
    } catch {
      return 127;
    }
  },
  sleep: (ms) => Bun.sleep(ms),
  async openUrl(url) {
    const opener = platform() === "darwin" ? "open" : "xdg-open";
    if (Bun.which(opener)) await realMachine.exec([opener, url]);
  },
  has: (tool) => Bun.which(tool) !== null,
};
