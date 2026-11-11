import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../adapters/run.ts";

export function fakeSystemd() {
  const units = new Map<string, { active: boolean; enabled: boolean }>();
  const starts = new Map<string, number>();
  const run: CommandRunner = async (command) => {
    if (command[0] !== "systemctl" || command[1] !== "--user") return { code: 127, stdout: "" };
    const [verb, ...rest] = command.slice(2);
    const unit = rest.at(-1)!;
    const state = units.get(unit) ?? { active: false, enabled: false };
    if (verb === "show") return { code: 0, stdout: `ActiveState=${state.active ? "active" : "inactive"}\nUnitFileState=${state.enabled ? "enabled" : ""}\nNeedDaemonReload=no\n` };
    if (verb === "enable") units.set(unit, { ...state, enabled: true });
    if (verb === "restart") units.set(unit, { ...state, active: true }), starts.set(unit, (starts.get(unit) ?? 0) + 1);
    if (verb === "disable") units.set(unit, { active: rest.includes("--now") ? false : state.active, enabled: false });
    if (verb === "stop") units.set(unit, { ...state, active: false });
    return { code: 0, stdout: "" };
  };
  const service = (home: string, id: string) => {
    const unit = `fleet-${id}.service`;
    const parts = [existsSync(join(home, ".config/systemd/user", unit)), units.get(unit)?.active === true, units.get(unit)?.enabled === true];
    return parts.every(Boolean) ? "running" : parts.some(Boolean) ? "partly removed" : "gone";
  };
  const started = (id: string) => starts.get(`fleet-${id}.service`) ?? 0;
  return { run, service, started };
}
