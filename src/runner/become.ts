const ignoredByBun = ["SIGPIPE", "SIGXFSZ"] as const;

export type Become = (argv: string[], env: Record<string, string | undefined>) => never;

export const become: Become = (argv, env) => {
  const [name = "", ...rest] = argv;
  const replace = process.execve;
  if (!replace) throw new Error(`this Bun cannot run ${name} in its own process`);
  const file = Bun.which(name, { PATH: env.PATH ?? "" }) ?? name;
  for (const signal of ignoredByBun) process.on(signal, () => {});
  const defined = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  replace(file, [name, ...rest], defined);
  throw new Error(`could not run ${name}`);
};
