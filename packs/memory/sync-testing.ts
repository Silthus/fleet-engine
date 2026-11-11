import { afterAll, beforeAll } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, gitEnv, tempDirs } from "../../src/testing/git.ts";

export const fakeToken = () => "ghp_" + "a1B2c3D4e5".repeat(4).slice(0, 36);

export function memorySyncHarness() {
  const syncTemp = tempDirs();
  afterAll(() => syncTemp.cleanup());

  function seed(root: string, remote: string, branch = "main") {
    const dir = join(root, `seed-${branch}`);
    git(root, "clone", "-q", remote, dir);
    git(dir, "checkout", "-q", "-b", branch);
    writeFileSync(join(dir, "MEMORY.md"), "# Memory\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "seed");
    git(dir, "push", "-q", "origin", branch);
  }

  let template: { empty: string; seeded: string };
  beforeAll(() => {
    const empty = syncTemp.make("memory-empty-");
    git(empty, "init", "-q", "--bare", "-b", "main", join(empty, "remote.git"));
    const seeded = syncTemp.make("memory-seeded-");
    cpSync(empty, seeded, { recursive: true });
    seed(seeded, join(seeded, "remote.git"));
    template = { empty, seeded };
  });

  function setup(seeded = true) {
    const root = syncTemp.make("memory-sync-");
    cpSync(seeded ? template.seeded : template.empty, root, { recursive: true });
    const remote = join(root, "remote.git");
    if (seeded) git(join(root, "seed-main"), "remote", "set-url", "origin", remote);
    return { root, remote };
  }

  async function sync(root: string, remote: string, machine: string, env: Record<string, string> = {}) {
    const home = join(root, `home-${machine}`);
    mkdirSync(home, { recursive: true });
    const child = Bun.spawn(["sh", join(import.meta.dir, "sync/sync.sh")], {
      env: { ...gitEnv, HOME: home, FLEET_MEMORY_URL: remote, CODER_WORKSPACE_NAME: machine, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out: out + err, checkout: join(home, ".agents/memory") };
  }

  function commitAll(dir: string, message: string, files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    git(dir, "push", "-q", "origin", "main");
  }

  function write(dir: string, files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }

  const remoteHistory = (root: string, remote: string) => git(root, "--git-dir", remote, "log", "-p", "--all");

  return { seed, setup, sync, commitAll, write, remoteHistory };
}
