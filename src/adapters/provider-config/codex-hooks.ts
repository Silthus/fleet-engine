import { createHash } from "node:crypto";
import { sortedJson, type Field } from "./fields.ts";

type HookGroup = { matcher?: string; hooks: Array<Record<string, unknown>> };

const snakeCase = (name: string) => name.replace(/(?<!^)[A-Z]/g, (letter) => `_${letter}`).toLowerCase();

export function trustedHash(event: string, group: HookGroup, handler: Record<string, unknown>) {
  const declaration = { event_name: snakeCase(event), ...(group.matcher === undefined ? {} : { matcher: group.matcher }), hooks: [{ async: false, timeout: 600, ...handler }] };
  return `sha256:${createHash("sha256").update(sortedJson(declaration)).digest("hex")}`;
}

export function codexHookTrust(owned: Field[], configPath: string): Field[] {
  return owned.flatMap((field) => {
    const [root, event, ...rest] = field.path;
    if (root !== "hooks" || !event || event === "state" || rest.length || !Array.isArray(field.value)) return [];
    return (field.value as HookGroup[]).flatMap((group, groupIndex) =>
      (group.hooks ?? []).map((handler, handlerIndex) => ({
        path: ["hooks", "state", `${configPath}:${snakeCase(event)}:${groupIndex}:${handlerIndex}`, "trusted_hash"],
        value: trustedHash(event, group, handler),
        pack: field.pack,
      })),
    );
  });
}
