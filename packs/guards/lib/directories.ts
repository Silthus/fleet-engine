import { isAbsolute, resolve } from "node:path";
import type { Command, Scope } from "./shell-words.ts";

export function changedDirectory(cwd: string | undefined, args: string[]): string | undefined {
  const target = args.find((arg) => !/^-[LPe@]+$/.test(arg));
  if (target === undefined || target === "-" || /[$`~]/.test(target)) return undefined;
  if (isAbsolute(target)) return resolve(target);
  return cwd === undefined ? undefined : resolve(cwd, target);
}

/** Each command with the directory it runs in, following `cd`, `pushd`, subshells and `env -C`. Undefined where the guard cannot tell. */
export function* withDirectories(commands: Command[], cwd: string): Generator<[Command, string | undefined]> {
  const directories = new Map<Scope, string | undefined>();
  const directoryOf = (scope: Scope): string | undefined => {
    if (!directories.has(scope)) {
      const start = scope.parent ? directoryOf(scope.parent) : cwd;
      directories.set(scope, scope.chdir === undefined ? start : changedDirectory(start, [scope.chdir]));
    }
    return directories.get(scope);
  };
  for (const command of commands) {
    const directory = directoryOf(command.scope);
    if (command.name === "cd" || command.name === "pushd") directories.set(command.scope, changedDirectory(directory, command.args));
    else if (command.name === "popd") directories.set(command.scope, undefined);
    yield [command, command.chdir === undefined ? directory : changedDirectory(directory, [command.chdir])];
  }
}
