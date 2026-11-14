import { createHash } from "node:crypto";
import { constants, tmpdir } from "node:os";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { proofKind, pullRequestDirectory, saveProof, uiWalkRule, writeJson } from "./proof.ts";
import { redactSecrets } from "../../base/hooks/secret-guard.ts";

export type SpoolFile = { write: (bytes: Uint8Array, offset: number, length: number) => Promise<{ bytesWritten: number }>; close: () => Promise<void> };
type SignalListener = (signal: NodeJS.Signals) => void;
export type GitRead = (args: string[], cwd: string) => Promise<{ ok: boolean; text: string }>;
export type RunIO = {
  stdout?: (chunk: Uint8Array) => void; stderr?: (chunk: Uint8Array) => void; spool?: (path: string) => Promise<SpoolFile>;
  signals?: { on: (signal: NodeJS.Signals, listener: SignalListener) => void; off: (signal: NodeJS.Signals, listener: SignalListener) => void };
};
export type ProofRun = {
  home: string; pr: { repository: string; pr: number }; kind: string; command: string[];
  cwd: string; env: Record<string, string | undefined>; print: (text: string) => void; io?: RunIO;
};

const sha = /^[0-9a-f]{40}$/;
const forwarded: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
const recordPath = (pullRequest: string, commit: string, kind: string, digest: string) => join(pullRequest, "runs", commit, kind, `${digest}.json`);
const signalExit = (signal: NodeJS.Signals) => 128 + (constants.signals[signal] ?? 0);

export async function runProof({ home, pr, kind, command, cwd, env, print, io = {} }: ProofRun): Promise<number> {
  const owed = proofKind(kind);
  if (owed === "ui-walk") throw new Error(uiWalkRule);
  const refuse = (problem: string, code: number) => { print(redactSecrets(`fleet proof run: ${problem}; nothing saved`)); return code; };
  const git: GitRead = (args, at) => gitRead(args, at, env);
  const root = await git(["rev-parse", "--show-toplevel"], cwd);
  const before = root.ok ? await treeState(root.text, git) : undefined;
  if (!root.ok || !before) return refuse("cannot read HEAD and the status of this checkout with Git", 1);
  if (before.status) return refuse(`the worktree is not clean:\n${before.status}\ncommit them, or remove them; a run proves a commit`, 2);

  const signals = io.signals ?? process;
  const cancel: Cancel = {};
  const onSignal = (signal: NodeJS.Signals) => { cancel.signal ??= signal; cancel.child?.kill(signal); };
  for (const signal of forwarded) signals.on(signal, onSignal);
  let spool: string | undefined;
  try {
    spool = await mkdtemp(join(env.TMPDIR || tmpdir(), "fleet-proof-run-"));
    const outcome = await capture(command, cwd, env, join(spool, "spool"), io, cancel);
    if (cancel.signal) return refuse(`the run was stopped by ${cancel.signal}`, signalExit(cancel.signal));
    if ("cannotStart" in outcome) return refuse(`cannot start ${command[0]}: ${outcome.cannotStart}`, 127);
    if ("failed" in outcome) return refuse(`the spool failed: ${outcome.failed}`, 1);
    if (outcome.signal) return refuse(`the command was stopped by ${outcome.signal}`, signalExit(outcome.signal));
    if (outcome.code !== 0) return refuse(`the command ended with exit ${outcome.code}`, outcome.code);
    if (!outcome.bytes.length) return refuse("no output to save", 1);
    if (outcome.bytes.includes(0)) return refuse("binary output: save the file with `fleet proof save`", 1);
    const after = await treeState(root.text, git);
    if (!after) return refuse("cannot read HEAD and the status of this checkout with Git after the run", 1);
    if (after.head !== before.head) return refuse(`HEAD moved from ${before.head.slice(0, 7)} to ${after.head.slice(0, 7)} during the run`, 1);
    if (after.status) return refuse(`the tree changed during the run:\n${after.status}`, 1);

    const text = Buffer.from(redactSecrets(new TextDecoder().decode(outcome.bytes)));
    const digest = createHash("sha256").update(text).digest("hex");
    const identity = { ...pr, commit: before.head };
    const record = recordPath(pullRequestDirectory(home, identity), before.head, owed, digest);
    await writeJson(record, { command: command.map(redactSecrets) });
    const output = join(spool, "output.log");
    await writeFile(output, text, { flag: "wx", mode: 0o600 });
    print(redactSecrets(await saveProof(home, identity, output, owed)));
    return 0;
  } catch (error) {
    return refuse(`the run failed: ${(error as Error).message}`, 1);
  } finally {
    if (spool) await rm(spool, { recursive: true, force: true });
    for (const signal of forwarded) signals.off(signal, onSignal);
  }
}

type Cancel = { signal?: NodeJS.Signals; child?: { kill: (signal: NodeJS.Signals) => void } };
type Captured = { cannotStart: string } | { failed: string } | { code: number; signal?: NodeJS.Signals; bytes: Buffer };

const openSpool = (path: string): Promise<SpoolFile> => open(path, "wx", 0o600);

async function writeAll(spool: SpoolFile, chunk: Uint8Array) {
  for (let offset = 0; offset < chunk.length;) {
    const { bytesWritten } = await spool.write(chunk, offset, chunk.length - offset);
    if (!(bytesWritten > 0)) throw new Error("the spool took no bytes");
    offset += bytesWritten;
  }
}

async function capture(command: string[], cwd: string, env: Record<string, string | undefined>, spoolPath: string, io: RunIO, cancel: Cancel): Promise<Captured> {
  const spool = await (io.spool ?? openSpool)(spoolPath);
  try {
    if (cancel.signal) return { code: 1, bytes: Buffer.alloc(0) };
    let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
    try { child = Bun.spawn(command, { cwd, env: env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); }
    catch (error) { return { cannotStart: (error as Error).message }; }
    cancel.child = child;
    let failure: string | undefined;
    let writing = Promise.resolve();
    const fail = (error: unknown) => { failure ??= (error as Error).message; child.kill("SIGKILL"); };
    const pump = async (stream: ReadableStream<Uint8Array>, terminal: (chunk: Uint8Array) => void) => {
      for await (const chunk of stream) {
        try { terminal(chunk); } catch {}
        writing = writing.then(() => failure === undefined ? writeAll(spool, chunk) : undefined).catch(fail);
      }
    };
    try {
      await Promise.all([child.exited, pump(child.stdout, io.stdout ?? ((chunk) => process.stdout.write(chunk))), pump(child.stderr, io.stderr ?? ((chunk) => process.stderr.write(chunk)))]);
      await writing;
    } finally { cancel.child = undefined; }
    if (failure !== undefined) return { failed: failure };
    if (child.signalCode) return { code: 1, signal: child.signalCode as NodeJS.Signals, bytes: Buffer.alloc(0) };
    return { code: child.exitCode ?? 1, bytes: await readFile(spoolPath) };
  } finally {
    await spool.close();
  }
}

async function treeState(root: string, git: GitRead) {
  const head = await git(["rev-parse", "--verify", "HEAD"], root);
  const status = await git(["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"], root);
  if (!head.ok || !sha.test(head.text) || !status.ok) return undefined;
  return { head: head.text, status: status.text };
}

async function gitRead(args: string[], cwd: string, env: Record<string, string | undefined>) {
  try {
    const child = Bun.spawn(["git", "--no-optional-locks", ...args], { cwd, env: env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { ok: code === 0, text: text.trimEnd() };
  } catch { return { ok: false, text: "" }; }
}

export async function runRecordOf(evidence: string): Promise<string[] | undefined> {
  const match = /^([0-9a-f]{64})\.log$/.exec(basename(evidence));
  const kindDirectory = dirname(evidence);
  const commit = basename(dirname(kindDirectory));
  if (!match || !sha.test(commit)) return undefined;
  try {
    const record = JSON.parse(await readFile(recordPath(dirname(dirname(kindDirectory)), commit, basename(kindDirectory), match[1]!), "utf8")) as { command?: unknown };
    const command = record?.command;
    if (!Array.isArray(command) || !command.length || !command.every((part) => typeof part === "string")) return undefined;
    if (createHash("sha256").update(await readFile(evidence)).digest("hex") !== match[1]) return undefined;
    return command as string[];
  } catch { return undefined; }
}
