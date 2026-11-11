const ignoredByBun = ["SIGPIPE", "SIGXFSZ"] as const;
const searchWithoutPath = "/usr/local/bin:/usr/bin:/bin";

export type Become = (argv: string[], env: Record<string, string | undefined>) => Promise<number>;

export const canBecome = () => typeof process.execve === "function";

export const become: Become = async (argv, env) => {
  const [name = "", ...rest] = argv;
  const replace = process.execve;
  if (!replace) return Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env }).exited;
  const file = Bun.which(name, { PATH: env.PATH || searchWithoutPath }) ?? name;
  for (const signal of ignoredByBun) process.on(signal, () => {});
  const defined = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  replace(file, [name, ...rest], defined);
  throw new Error(`could not run ${name}`);
};
