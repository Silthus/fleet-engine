import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli.ts";

export const repoRoot = join(import.meta.dir, "../..");

export function cliFixtures(temp: { make(prefix?: string): string }) {
  function profileDir(packs: string[] = [], aboutMe?: string) {
    const dir = temp.make("profile-");
    const profile = { schema: 1, engine: { repo: "Silthus/fleet-engine", ref: "main", channel: "track" }, sources: [], packs, plan: "both", settings: {}, workflows: {} };
    writeFileSync(join(dir, "fleet.json"), JSON.stringify(profile));
    if (aboutMe) writeFileSync(join(dir, "about-me.md"), aboutMe);
    return dir;
  }

  async function fleet(args: string[], home: string, engineRoot = repoRoot, env: Record<string, string> = {}) {
    const lines: string[] = [];
    const code = await main(args, { home, engineRoot, platform: "linux", env, print: (line) => lines.push(line), run: async () => 0 });
    return { code, output: lines.join("\n") };
  }

  function engineWithCommands() {
    const root = temp.make("engine-");
    cpSync(join(repoRoot, "packs/base"), join(root, "packs/base"), { recursive: true });
    for (const pack of ["tools", "rival"]) {
      mkdirSync(join(root, "packs", pack, "commands"), { recursive: true });
      writeFileSync(join(root, "packs", pack, "pack.json"), JSON.stringify({ schema: 1, name: pack, summary: `${pack} pack.`, ...(pack === "rival" ? { title: "Rival Tools" } : {}) }));
      writeFileSync(join(root, "packs", pack, "commands/hello.ts"), `await Bun.write(Bun.env.HOME + "/hello.txt", "${pack} " + Bun.argv.slice(2).join(" "));\n`);
    }
    return root;
  }

  return { profileDir, fleet, engineWithCommands };
}
