import { join } from "node:path";
import { runCommand } from "../lib/command.ts";
import { numberSetting } from "../lib/settings.ts";

const forwarded = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

await runCommand(() => {
  const { FLEET_HEAVY_ROUTE: _, FLEET_HEAVY_ROUTED: routed, ...inherited } = Bun.env;
  const route = routed ? undefined : (JSON.parse(Bun.env.FLEET_HANDLERS || "{}") as Record<string, string>)["heavy-route"];
  const env = { ...inherited, FLEET_HEAVY_SLOTS: Bun.env.FLEET_HEAVY_SLOTS || String(numberSetting("base.heavySlots")), ...(route ? { FLEET_HEAVY_ROUTE: route } : {}) };
  const script = join(import.meta.dir, "../lib/heavy.sh");
  const child = Bun.spawn(["sh", script, ...Bun.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"], env, detached: true });
  const toGroup = (signal: (typeof forwarded)[number]) => {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  };
  for (const signal of forwarded) process.on(signal, () => toGroup(signal));
  return child.exited;
});
