import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { AvailableSource, MachineFile } from "../../src/pack/types.ts";
import type { Machine } from "../../src/setup/commands.ts";
import { humanStep, packSignIn } from "../../src/setup/human.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { engineSource, mac, resolveEngine, skillSources } from "../../src/testing/packs.ts";
import { slackTrigger } from "./lib/command.ts";
import { Interrupted, secretReader } from "./lib/secret.ts";

const temp = tempDirs();
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  temp.cleanup();
});

const ownerId = "U0OWNER";
const appToken = "xapp-test-app-token";
const userToken = "xoxp-test-user-token";
const otherUserToken = "xoxp-test-someone-else";
const settings = JSON.stringify({ "slack.userId": ownerId });
const tokens = [appToken, userToken, otherUserToken];

function slackStub(hold: Promise<void> = Promise.resolve()) {
  const methods: string[] = [];
  let checking = () => {};
  const checked = new Promise<void>((resolve) => (checking = resolve));
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const method = new URL(request.url).pathname.replace(/^\/api\//, "");
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
      methods.push(method);
      if (method === "apps.connections.open") return Response.json(token === appToken ? { ok: true, url: "ws://127.0.0.1:1/socket" } : { ok: false, error: "invalid_auth" });
      if (method === "auth.test" && token === otherUserToken) checking(), await hold;
      if (method === "auth.test") return Response.json(token === userToken ? { ok: true, user_id: ownerId } : token === otherUserToken ? { ok: true, user_id: "U0SOMEONE" } : { ok: false, error: "invalid_auth" });
      return Response.json({ ok: false, error: "unknown_method" });
    },
  });
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}/api`, methods, checked };
}

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
const tokensPath = (home: string) => join(home, ".config/fleet/slack-app.json");

function harness(home: string) {
  const script = join(home, "harness.ts");
  writeFileSync(script, `import { slackTrigger } from ${JSON.stringify(resolve(import.meta.dir, "lib/command.ts"))};
const run = async (argv: string[]) => argv[0] === "git" ? { code: 0, stdout: "Nora Example\\n", stderr: "" } : { code: 127, stdout: "", stderr: "" };
process.exit(await slackTrigger(["setup"], { env: Bun.env, home: Bun.env.HOME!, print: (line) => console.log(line), readStdin: () => Bun.stdin.text(), run, slackBase: Bun.argv[2] }));
`);
  return script;
}

function inTerminal(command: string[], env: Record<string, string>) {
  const line = command.map((part) => `'${part}'`).join(" ");
  const argv = process.platform === "linux" ? ["script", "-qec", line, "/dev/null"] : ["script", "-q", "/dev/null", "sh", "-c", line];
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } });
  stops.push(() => child.kill());
  const decoder = new TextDecoder();
  let screen = "";
  let seen = 0;
  let over = false;
  const waiters: Array<() => boolean> = [];
  const shown = (prompt: string) => {
    const found = screen.indexOf(prompt, seen);
    if (found >= 0) seen = found + prompt.length;
    return found >= 0;
  };
  const output = (async () => {
    for await (const chunk of child.stdout) {
      screen += decoder.decode(chunk, { stream: true });
      for (const waiter of waiters.splice(0)) if (!waiter()) waiters.push(waiter);
    }
    screen += decoder.decode();
    over = true;
    for (const waiter of waiters.splice(0)) waiter();
  })();
  const type = (text: string) => {
    child.stdin.write(text);
    child.stdin.flush();
  };
  return {
    screen: async () => (await output, screen),
    exited: child.exited,
    type,
    async answer(prompt: string, text: string) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => (shown(prompt) ? (resolve(), true) : over ? (reject(new Error(`the wizard ended before it asked: ${prompt}`)), true) : false);
        if (!ready()) waiters.push(ready);
      });
      type(`${text}\r`);
    },
  };
}

describe("fleet slack-trigger setup", () => {
  test("in a terminal, reads both tokens without echo, also typed ahead while Slack checks the last one, rejects a token for someone else, and saves them with mode 600 and nowhere else", async () => {
    let typed = () => {};
    const slack = slackStub(new Promise<void>((resolve) => (typed = resolve)));
    const home = temp.make("home-");
    const profile = join(home, "profile");
    mkdirSync(profile);
    writeFileSync(join(profile, "fleet.json"), "{}\n");
    const terminal = inTerminal(["bun", harness(home), slack.base], { HOME: home, FLEET_SETTINGS: settings, FLEET_PROFILE_DIR: profile });
    await terminal.answer("app-level token (xapp-…, hidden): ", appToken);
    await terminal.answer("user token (xoxp-…, hidden): ", otherUserToken);
    await slack.checked;
    terminal.type(`${userToken}\r`);
    typed();
    expect(await terminal.exited).toBe(0);
    const screen = await terminal.screen();
    expect(screen).toContain("not to slack.userId U0OWNER");
    expect(screen).toContain("readable only by you");
    for (const token of tokens) expect(screen).not.toContain(token);
    expect(statSync(tokensPath(home)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(tokensPath(home), "utf8"))).toEqual({ appToken, userToken });
    const others = files(home).filter((path) => path !== tokensPath(home) && !path.endsWith("harness.ts"));
    for (const path of others) for (const token of tokens) expect([path, readFileSync(path, "utf8").includes(token)]).toEqual([path, false]);
    expect(slack.methods).toEqual(["apps.connections.open", "auth.test", "auth.test"]);
  });

  test("asks again for a token with the wrong prefix or one Slack refuses, and saves nothing when stopped", async () => {
    const slack = slackStub();
    const home = temp.make("home-");
    const answers = ["xoxp-not-an-app-token", "xapp-test-refused", appToken];
    const printed: string[] = [];
    const prompts: string[] = [];
    const code = await slackTrigger(["setup"], {
      env: { FLEET_SETTINGS: settings },
      home,
      print: (line) => printed.push(line),
      readStdin: async () => "",
      run: async () => ({ code: 0, stdout: "Nora Example\n", stderr: "" }),
      slackBase: slack.base,
      readSecret: async (prompt) => {
        prompts.push(prompt.trim());
        const next = answers.shift();
        if (next === undefined) throw new Interrupted();
        return next;
      },
    });
    expect(code).toBe(130);
    expect(prompts.map((prompt) => prompt.split(" (")[0])).toEqual(["Paste the app-level token", "Paste the app-level token", "Paste the app-level token", "Paste the user token"]);
    expect(printed.join("\n")).toContain("does not start with xapp-");
    expect(printed.join("\n")).toContain("Slack did not accept it: apps.connections.open: invalid_auth");
    expect(printed.join("\n")).toContain("Nothing was saved");
    expect(printed.join("\n")).not.toContain("xapp-test");
    expect(existsSync(tokensPath(home))).toBe(false);
  });

  test("never prints a token that Slack echoes in its error, however often, and also not the token pasted before it", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const method = new URL(request.url).pathname.replace(/^\/api\//, "");
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        if (method === "apps.connections.open") return Response.json({ ok: true, url: "ws://127.0.0.1:1/socket" });
        return Response.json({ ok: false, error: `${token} is bad, ${token}, and so is ${appToken}` });
      },
    });
    stops.push(() => server.stop(true));
    const answers = [appToken, userToken];
    const printed: string[] = [];
    const code = await slackTrigger(["setup"], {
      env: { FLEET_SETTINGS: settings },
      home: temp.make("home-"),
      print: (line) => printed.push(line),
      readStdin: async () => "",
      run: async () => ({ code: 0, stdout: "Nora Example\n", stderr: "" }),
      slackBase: `http://127.0.0.1:${server.port}/api`,
      readSecret: async () => {
        const next = answers.shift();
        if (next === undefined) throw new Interrupted();
        return next;
      },
    });
    expect(code).toBe(130);
    expect(printed.join("\n")).toContain("Slack did not accept it: auth.test: … is bad, …, and so is …");
    for (const token of tokens) expect(printed.join("\n")).not.toContain(token);
  });
});

describe("the secret reader", () => {
  function keyboard(tty = false) {
    const stream = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
    const modes: boolean[] = [];
    if (tty) {
      stream.isTTY = true;
      stream.setRawMode = (on) => void modes.push(on);
    }
    let interrupted = 0;
    let stopped = () => {};
    const ctrlC = new Promise<void>((resolve) => (stopped = resolve));
    const reader = secretReader(stream as unknown as NodeJS.ReadStream, new PassThrough(), () => (interrupted++, stopped()));
    return { stream, modes, reader, ctrlC, interrupted: () => interrupted };
  }

  test("drops erased keys, splits lines, and stops on Ctrl-C or the end of input", async () => {
    const { stream, reader } = keyboard();
    stream.write("xapp-ab\x7fc\r\nxoxp-1\n");
    expect(await reader.read("first: ")).toBe("xapp-ac");
    expect(await reader.read("second: ")).toBe("xoxp-1");
    const third = reader.read("third: ");
    stream.write("half\x03");
    await expect(third).rejects.toBeInstanceOf(Interrupted);
    const fourth = reader.read("fourth: ");
    stream.end();
    await expect(fourth).rejects.toBeInstanceOf(Interrupted);
  });

  test("keeps a CRLF and a character split across chunks whole, and erases a whole character", async () => {
    const { stream, reader } = keyboard();
    const first = reader.read("first: ");
    stream.write("xapp-1\r");
    expect(await first).toBe("xapp-1");
    const second = reader.read("second: ");
    const accent = Buffer.from("é");
    stream.write(Buffer.concat([Buffer.from("\nxoxp-"), accent.subarray(0, 1)]));
    stream.write(Buffer.concat([accent.subarray(1), Buffer.from("\x7fOK🙂\x7f\n")]));
    expect(await second).toBe("xoxp-OK");
  });

  test("keeps echo off from the first question until it closes, and stops at once on Ctrl-C between questions", async () => {
    const { stream, modes, reader, ctrlC, interrupted } = keyboard(true);
    stream.write("xapp-1\n");
    await reader.read("first: ");
    stream.write("xoxp-typed-ahead");
    stream.write("\x03");
    await ctrlC;
    expect(interrupted()).toBe(1);
    expect(modes).toEqual([true, false]);
    const { stream: again, modes: kept, reader: second } = keyboard(true);
    again.write("xapp-1\nxoxp-2\n");
    await second.read("first: ");
    await second.read("second: ");
    expect(kept).toEqual([true]);
    second.close();
    expect(kept).toEqual([true, false]);
  });
});

describe("the Slack app step", () => {
  let sources: AvailableSource[];
  beforeAll(async () => {
    const engine = await engineSource();
    sources = [engine, ...skillSources(temp.make("skills-"), engine)];
  });
  const plan = (machine: MachineFile = mac) => resolveEngine(sources, { packs: ["slack"], workflows: { "slack-thread": true }, settings: { "slack.userId": ownerId } }, machine);

  test("runs fleet slack-trigger setup in the foreground, and its probe passes only for a tokens file with mode 600", () => {
    const step = plan().human.find((item) => item.pack === "slack")!;
    expect(step).toMatchObject({ id: "slack-app", command: "fleet slack-trigger setup", interactive: true, workflow: "slack-thread" });
    expect(resolveEngine(sources, { packs: ["slack"], settings: { "slack.userId": ownerId } }, mac).human.filter((item) => item.pack === "slack")).toEqual([]);
    const home = temp.make("probe-");
    const probe = () => Bun.spawnSync(step.probe, { env: { HOME: home, PATH: "/usr/bin:/bin" } }).exitCode;
    expect(probe()).not.toBe(0);
    mkdirSync(join(home, ".config/fleet"), { recursive: true });
    writeFileSync(tokensPath(home), "{}", { mode: 0o644 });
    expect(probe()).not.toBe(0);
    writeFileSync(join(home, ".config/fleet/other.json"), "{}", { mode: 0o600 });
    expect(probe()).not.toBe(0);
    Bun.spawnSync(["chmod", "600", tokensPath(home)]);
    expect(probe()).toBe(0);
  });

  test("is skipped without running the wizard when setup runs with --non-interactive", async () => {
    const step = plan().human.find((item) => item.pack === "slack")!;
    const ran: string[][] = [];
    const printed: string[] = [];
    const machine = {
      exec: async (command: string[]) => (ran.push(command), { code: 1, output: "" }),
      run: async (command: string[]) => (ran.push(command), 0),
      start: () => { throw new Error("no background sign-in"); },
      sleep: async () => {},
      openUrl: async () => {},
      has: () => true,
    } as unknown as Machine;
    const context = { terminal: { print: (line: string) => printed.push(line), ask: async () => "" }, machine, nonInteractive: true };
    const outcome = await humanStep(packSignIn(step, [], context, undefined), context).run();
    expect(outcome).toBe("unanswered");
    expect(ran).toEqual([step.probe]);
    expect(printed).toEqual([]);
  });
});
