import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableSource } from "../../src/pack/types.ts";
import { tempDirs } from "../../src/testing/git.ts";
import { packageAgeCommand } from "./lib/package-age.ts";
import { devbox, engineSource, mac, resolveEngine, skillSources } from "../../src/testing/packs.ts";

const temp = tempDirs();
afterEach(() => temp.cleanup());
let engine: AvailableSource;
beforeAll(async () => (engine = await engineSource()));

const plan = (workflows: Record<string, boolean>, machine = devbox) => resolveEngine([engine, ...skillSources(temp.make("skills-"), engine)], { packs: ["guards"], workflows }, machine);

describe("the package age workflow", () => {
  const packageAge = join(import.meta.dir, "commands/package-age.ts");
  const fleet = (home: string, ...args: string[]) => {
    const result = Bun.spawnSync(["bun", packageAge, ...args], { env: { PATH: process.env.PATH!, HOME: home }, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stdout: result.stdout.toString().trim() };
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };

  test("runs fleet package-age as a step on every machine, with its own check", () => {
    expect(plan({}).steps.map((step) => step.id)).not.toContain("package-age");
    for (const machine of [devbox, mac]) {
      expect(plan({ "package-age": true }, machine).steps.find((step) => step.id === "package-age")).toMatchObject({ run: ["fleet", "package-age"], check: ["fleet", "package-age", "--check"] });
    }
  });

  test("gives pnpm and Bun a three-day minimum release age on a fresh home, once", () => {
    const home = temp.make("home-");
    expect(fleet(home, "--check").code).toBe(1);
    expect(fleet(home)).toMatchObject({ code: 0, stdout: expect.stringContaining("3-day minimum release age") });
    expect(readFileSync(join(home, ".config/pnpm/config.yaml"), "utf8")).toBe("minimumReleaseAge: 4320\n");
    expect(readFileSync(join(home, ".bunfig.toml"), "utf8")).toBe("[install]\nminimumReleaseAge = 259200\n");
    expect(fleet(home, "--check").code).toBe(0);
    expect(fleet(home)).toEqual({ code: 0, stdout: "" });
  });

  test("keeps every key the person already set and adds only the missing age", () => {
    const home = temp.make("home-");
    write(join(home, ".config/pnpm/config.yaml"), "store-dir: /data/pnpm");
    write(join(home, ".bunfig.toml"), '[install]\nregistry = "https://registry.example"\n\n[test]\npreload = ["./setup.ts"]\n');
    expect(fleet(home).code).toBe(0);
    expect(readFileSync(join(home, ".config/pnpm/config.yaml"), "utf8")).toBe("store-dir: /data/pnpm\nminimumReleaseAge: 4320\n");
    expect(readFileSync(join(home, ".bunfig.toml"), "utf8")).toBe('[install]\nminimumReleaseAge = 259200\nregistry = "https://registry.example"\n\n[test]\npreload = ["./setup.ts"]\n');
  });

  test("never changes an age the person chose", () => {
    const home = temp.make("home-");
    write(join(home, ".config/pnpm/config.yaml"), "minimumReleaseAge: 10080\n");
    write(join(home, ".bunfig.toml"), "[install]\nminimumReleaseAge = 0\n");
    expect(fleet(home, "--check").code).toBe(0);
    expect(fleet(home)).toEqual({ code: 0, stdout: "" });
    expect(readFileSync(join(home, ".config/pnpm/config.yaml"), "utf8")).toBe("minimumReleaseAge: 10080\n");
    expect(readFileSync(join(home, ".bunfig.toml"), "utf8")).toBe("[install]\nminimumReleaseAge = 0\n");
  });

  test("finds pnpm's config where pnpm reads it on a Mac", () => {
    const home = temp.make("home-");
    expect(packageAgeCommand([], { home, platform: "darwin", print: () => {} })).toBe(0);
    expect(readFileSync(join(home, "Library/Preferences/pnpm/config.yaml"), "utf8")).toBe("minimumReleaseAge: 4320\n");
  });
});

describe("the OOM survival workflow", () => {
  test("keeps T3's agent scopes alive and asks a person to install earlyoom, on a Linux devbox only", () => {
    expect(plan({}).files.map((file) => file.target)).not.toContain(".config/systemd/user/t3code-.scope.d/90-fleet-oom.conf");
    const on = plan({ "oom-survival": true });
    const dropIn = on.files.find((file) => file.target === ".config/systemd/user/t3code-.scope.d/90-fleet-oom.conf");
    expect(dropIn && "source" in dropIn ? readFileSync(dropIn.source, "utf8") : "").toBe("[Scope]\nOOMPolicy=continue\n");
    expect(on.steps.find((step) => step.id === "oom-scope-reload")?.run).toEqual(["systemctl", "--user", "daemon-reload"]);
    expect(on.human.find((step) => step.id === "earlyoom")).toMatchObject({ command: "sudo sh ~/.local/share/fleet/guards/earlyoom.sh", probe: ["systemctl", "is-active", "--quiet", "earlyoom"] });
    const onMac = plan({ "oom-survival": true }, mac);
    expect(onMac.files.filter((file) => file.target.includes("systemd"))).toEqual([]);
    expect(onMac.human).toEqual([]);
  });

  const packageDefault = 'EARLYOOM_ARGS="-r 3600"\n';

  function machine() {
    const root = temp.make("root-");
    const state = temp.make("state-");
    const bin = temp.make("bin-");
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${state}/log"\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    const md5 = new Bun.CryptoHasher("md5").update(packageDefault).digest("hex");
    stub("dpkg-query", `[ -e "${state}/installed" ] || exit 1\ncase "$*" in *Status*) printf 'install ok installed' ;; *) printf ' /etc/default/earlyoom ${md5}\\n /etc/other 0\\n' ;; esac`);
    stub("apt-get", `touch "${state}/installed"\nmkdir -p "${root}/etc/default"\nprintf '%s' '${packageDefault}' > "${root}/etc/default/earlyoom"`);
    stub("systemctl", `case "$*" in "is-active --quiet earlyoom") [ -e "${state}/active" ] ;; *now*|restart*) [ -e "${state}/broken" ] || touch "${state}/active" ;; esac`);
    const config = join(root, "etc/default/earlyoom");
    const run = () => {
      writeFileSync(join(state, "log"), "");
      const result = Bun.spawnSync(["sh", join(import.meta.dir, "system/earlyoom.sh")], { env: { PATH: `${bin}:${process.env.PATH}`, FLEET_SYSTEM_ROOT: root }, stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim(), log: readFileSync(join(state, "log"), "utf8").split("\n").filter((line) => /^(apt-get|systemctl) /.test(line)) };
    };
    return { root, state, config, run };
  }

  test("installs earlyoom, replaces the package's default config, and restarts it once", () => {
    const box = machine();
    const first = box.run();
    expect(first).toMatchObject({ code: 0, stdout: expect.stringContaining("earlyoom: on.") });
    expect(first.log).toEqual(["apt-get install -y earlyoom", "systemctl enable earlyoom", "systemctl restart earlyoom", "systemctl is-active --quiet earlyoom"]);
    const config = readFileSync(box.config, "utf8");
    expect(config).toStartWith("# Managed by Fleet's Guards pack.");
    expect(config).toContain("-m 10,7 --prefer ^(node|");
    expect(config).toMatch(/--avoid \^\(t3\|[^)]*claude\|codex/);

    expect(box.run().log).toEqual(["systemctl enable --now earlyoom", "systemctl is-active --quiet earlyoom"]);
  });

  test("keeps an earlyoom config the person wrote and never restarts with it", () => {
    const box = machine();
    writeFileSync(join(box.state, "installed"), "");
    mkdirSync(join(box.root, "etc/default"), { recursive: true });
    writeFileSync(box.config, 'EARLYOOM_ARGS="-m 5"\n');
    const kept = box.run();
    expect(kept).toMatchObject({ code: 0, stdout: expect.stringContaining("kept your own") });
    expect(kept.log).not.toContain("systemctl restart earlyoom");
    expect(readFileSync(box.config, "utf8")).toBe('EARLYOOM_ARGS="-m 5"\n');
  });

  test("replaces a config an older Fleet wrote", () => {
    const box = machine();
    writeFileSync(join(box.state, "installed"), "");
    mkdirSync(join(box.root, "etc/default"), { recursive: true });
    writeFileSync(box.config, `# Managed by Fleet's Guards pack. Delete this line to keep your own settings.\nEARLYOOM_ARGS="-m 20"\n`);
    expect(box.run().log).toContain("systemctl restart earlyoom");
    expect(readFileSync(box.config, "utf8")).toContain("-m 10,7");
  });

  test("fails and says where to look when earlyoom does not start", () => {
    const box = machine();
    writeFileSync(join(box.state, "broken"), "");
    const result = box.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("journalctl -u earlyoom");
  });
});
