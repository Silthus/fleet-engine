import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("keeps a Bun setting written in any TOML form, and leaves a config it cannot edit safely untouched", () => {
    const cases: Array<[text: string, edited: boolean]> = [
      ['install = { registry = "https://registry.example" }\n', false],
      ['["install"]\nregistry = "https://registry.example"\n', true],
      ['[install]\n"minimumReleaseAge" = 600\n', false],
      ['[install] # packages\r\nregistry = "https://registry.example"\r\n', true],
      ["[install\n", false],
    ];
    for (const [text, edited] of cases) {
      const home = temp.make("home-");
      write(join(home, ".config/pnpm/config.yaml"), "minimumReleaseAge: 4320\n");
      write(join(home, ".bunfig.toml"), text);
      const result = fleet(home);
      const after = readFileSync(join(home, ".bunfig.toml"), "utf8");
      if (edited) {
        expect([text, result.code, Bun.TOML.parse(after)]).toEqual([text, 0, expect.objectContaining({ install: expect.objectContaining({ minimumReleaseAge: 259200, registry: "https://registry.example" }) })]);
      } else {
        expect([text, after]).toEqual([text, text]);
        const parsed = (() => { try { return Bun.TOML.parse(text) as { install?: { minimumReleaseAge?: number } }; } catch { return undefined; } })();
        expect([text, result.code]).toEqual([text, parsed?.install?.minimumReleaseAge === undefined ? 1 : 0]);
      }
    }
  });

  test("keeps Windows line endings when it adds the Bun setting", () => {
    const home = temp.make("home-");
    write(join(home, ".bunfig.toml"), '[install]\r\nregistry = "https://registry.example"\r\n');
    fleet(home);
    expect(readFileSync(join(home, ".bunfig.toml"), "utf8")).toBe('[install]\r\nminimumReleaseAge = 259200\r\nregistry = "https://registry.example"\r\n');
  });

  test("keeps a pnpm setting written in any YAML form, and leaves a config it cannot edit safely untouched", () => {
    const cases: Array<[text: string, code: number]> = [
      ['"minimumReleaseAge": 10080\n', 0],
      ["  store-dir: /data/pnpm\n  verify-store-integrity: true\n", 1],
      ["- not a mapping\n", 1],
    ];
    for (const [text, code] of cases) {
      const home = temp.make("home-");
      write(join(home, ".bunfig.toml"), "[install]\nminimumReleaseAge = 259200\n");
      write(join(home, ".config/pnpm/config.yaml"), text);
      expect([text, fleet(home).code, readFileSync(join(home, ".config/pnpm/config.yaml"), "utf8")]).toEqual([text, code, text]);
      expect([text, fleet(home, "--check").code]).toEqual([text, code]);
    }
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
    expect(on.human.find((step) => step.id === "earlyoom")).toMatchObject({ command: "sudo sh ~/.local/share/fleet/guards/earlyoom.sh", probe: ["sh", "-c", 'sh "$HOME/.local/share/fleet/guards/earlyoom.sh" --check'], interactive: true });
    const onMac = plan({ "oom-survival": true }, mac);
    expect(onMac.files.filter((file) => file.target.includes("systemd"))).toEqual([]);
    expect(onMac.human).toEqual([]);
    expect(onMac.checks).toEqual([]);
  });

  test("says when systemd is too old to keep T3's agent scopes alive", () => {
    const check = plan({ "oom-survival": true }).checks.find((item) => item.id === "scope-oom-policy")!;
    expect(check.say).toContain("systemd 253");
    const bin = temp.make("bin-");
    const systemdVersion = (version: string) => {
      writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "systemd ${version} (${version}.1-1)"\necho "+PAM +AUDIT"\n`);
      chmodSync(join(bin, "systemctl"), 0o755);
      return Bun.spawnSync(check.run, { env: { PATH: `${bin}:${process.env.PATH}` } }).exitCode;
    };
    expect([systemdVersion("252"), systemdVersion("253"), systemdVersion("257")]).toEqual([1, 0, 0]);
  });

  const packageDefault = 'EARLYOOM_ARGS="-r 3600"\n';

  function machine() {
    const root = temp.make("root-");
    const state = temp.make("state-");
    const bin = temp.make("bin-");
    const config = join(root, "etc/default/earlyoom");
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    const md5 = new Bun.CryptoHasher("md5").update(packageDefault).digest("hex");
    stub("dpkg-query", `[ -e "${state}/installed" ] || exit 1\ncase "$*" in *Status*) printf 'install ok installed' ;; *) [ -e "${state}/no-conffiles" ] || printf ' /etc/default/earlyoom ${md5}\\n /etc/other 0\\n' ;; esac`);
    stub("md5sum", `[ -e "${state}/no-md5sum" ] && exit 127\nexec ${Bun.which("md5sum")} "$@"`);
    stub("apt-get", `touch "${state}/installed"\nmkdir -p "${root}/etc/default"\nprintf '%s' '${packageDefault}' > "${config}"`);
    stub(
      "systemctl",
      [
        `start() { [ -e "${state}/broken" ] && return; cp "${config}" "${state}/running-config"; echo x >> "${state}/starts"; }`,
        `case "$*" in`,
        `  "is-active --quiet earlyoom") [ -e "${state}/running-config" ] ;;`,
        `  "enable earlyoom") touch "${state}/enabled" ;;`,
        `  "enable --now earlyoom") touch "${state}/enabled"; [ -e "${state}/running-config" ] || start ;;`,
        `  "restart earlyoom") start ;;`,
        `esac`,
      ].join("\n"),
    );
    const read = (name: string) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8") : undefined);
    const service = () => ({ installed: existsSync(join(state, "installed")), enabled: existsSync(join(state, "enabled")), runningConfig: read("running-config"), starts: (read("starts") ?? "").split("\n").filter(Boolean).length });
    const writeConfig = (text: string) => {
      mkdirSync(join(root, "etc/default"), { recursive: true });
      writeFileSync(config, text);
    };
    const run = (...args: string[]) => {
      const result = Bun.spawnSync(["sh", join(import.meta.dir, "system/earlyoom.sh"), ...args], { env: { PATH: `${bin}:${process.env.PATH}`, FLEET_SYSTEM_ROOT: root }, stdout: "pipe", stderr: "pipe" });
      return { code: result.exitCode, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
    };
    const install = () => writeFileSync(join(state, "installed"), "");
    const start = () => writeFileSync(join(state, "running-config"), readFileSync(config, "utf8"));
    const stop = () => rmSync(join(state, "running-config"));
    const flag = (name: string) => writeFileSync(join(state, name), "");
    return { config, run, service, writeConfig, install, start, stop, flag };
  }

  test("installs earlyoom, enables it, and runs it with Fleet's config instead of the package's default", () => {
    const box = machine();
    expect(box.run()).toMatchObject({ code: 0, stdout: expect.stringContaining("earlyoom: on.") });
    const config = readFileSync(box.config, "utf8");
    expect(config).toStartWith("# Managed by Fleet's Guards pack.");
    expect(config).toContain("-m 10,7 -s 100,100 --prefer ^(node|");
    expect(config).toMatch(/--avoid \^\(t3\|[^)]*claude\|codex/);
    expect(box.service()).toEqual({ installed: true, enabled: true, runningConfig: config, starts: 1 });

    expect(box.run().code).toBe(0);
    expect(box.service().starts).toBe(1);
    box.stop();
    expect(box.run().code).toBe(0);
    expect(box.service()).toMatchObject({ runningConfig: config, starts: 2 });
  });

  test("keeps an earlyoom config the person wrote and runs earlyoom with it", () => {
    const box = machine();
    box.install();
    box.writeConfig('EARLYOOM_ARGS="-m 5"\n');
    expect(box.run()).toMatchObject({ code: 0, stdout: expect.stringContaining("kept your own") });
    expect(readFileSync(box.config, "utf8")).toBe('EARLYOOM_ARGS="-m 5"\n');
    expect(box.service()).toMatchObject({ enabled: true, runningConfig: 'EARLYOOM_ARGS="-m 5"\n' });
  });

  test("replaces a config an older Fleet wrote, and restarts earlyoom with the new one", () => {
    const box = machine();
    box.install();
    box.writeConfig(`# Managed by Fleet's Guards pack. Delete this line to keep your own settings.\nEARLYOOM_ARGS="-m 20"\n`);
    box.start();
    expect(box.run().code).toBe(0);
    expect(box.service().runningConfig).toContain("-m 10,7");
  });

  test("never takes a config it cannot tell from the package's default, and its check fails until a person decides", () => {
    for (const missing of ["no-conffiles", "no-md5sum"]) {
      const box = machine();
      box.install();
      box.writeConfig(packageDefault);
      box.start();
      box.flag(missing);
      expect([missing, box.run().code, box.run("--check").code]).toEqual([missing, 1, 1]);
      expect([missing, readFileSync(box.config, "utf8")]).toEqual([missing, packageDefault]);
    }
  });

  test("its check passes only while earlyoom runs with Fleet's config or one the person wrote, and changes nothing", () => {
    const box = machine();
    expect(box.run("--check").code).toBe(1);
    expect(box.service()).toEqual({ installed: false, enabled: false, runningConfig: undefined, starts: 0 });
    box.install();
    box.writeConfig(packageDefault);
    box.start();
    expect(box.run("--check").code).toBe(1);
    expect(readFileSync(box.config, "utf8")).toBe(packageDefault);
    box.run();
    const before = box.service();
    expect(box.run("--check").code).toBe(0);
    expect(box.service()).toEqual(before);
    box.writeConfig('EARLYOOM_ARGS="-m 5"\n');
    expect(box.run("--check").code).toBe(0);
    box.writeConfig(`# Managed by Fleet's Guards pack. Delete this line to keep your own settings.\nEARLYOOM_ARGS="-m 20"\n`);
    expect(box.run("--check").code).toBe(1);
    box.flag("no-conffiles");
    box.writeConfig(packageDefault);
    expect(box.run("--check").code).toBe(1);
  });

  test("fails and says where to look when earlyoom does not start", () => {
    const box = machine();
    box.flag("broken");
    const result = box.run();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("journalctl -u earlyoom");
  });
});
