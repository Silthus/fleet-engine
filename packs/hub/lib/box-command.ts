import { canBeDevbox, isBoxName } from "../../../src/hub/names.ts";
import { grant, reap, type Coder } from "./coder.ts";
import { assertBox, link, restoreForwards, unlink, type BoxCoder } from "./links.ts";
import { quote, requireHub, type Machine } from "./machine.ts";
import { LockBusy, userWaitMs, withBoxLock } from "./box-lock.ts";
import { idle, list, lockWait, nightly, nightlySteps, ownership, refreshPool, release, saveToken, spawn, startBox, sweep, threads, type BoxHooks } from "./box.ts";
import * as registry from "./pool.ts";

export type CommandCoder = BoxCoder & Pick<Coder, "env" | "token">;
export type BoxDeps = { machine(): Machine; coder(here: Machine): CommandCoder; readStdin(): Promise<string>; hooks: BoxHooks };

const usage = `Usage: fleet box spawn [<name>] [--new]
                                   Claim a stopped box from the pool, or create box-<name>; set it up like a devbox,
                                   link it to T3 on the hub and every devbox, and print "<box> <environmentId>"
       fleet box link <box>        Forward a box's T3 to this machine and link it without an approval
       fleet box unlink <box>      Unlink a box here and stop its forward
       fleet box release <box> [--force] [--delete]
                                   Return a box to the pool and stop it, or, when the pool is full or with
                                   --delete, unlink it everywhere and delete it; refuses while its threads
                                   still run or wait for an answer, unless forced
       fleet box list              List the boxes
       fleet box run <box> -- <command>
                                   Run a command in a login shell on the box with Fleet's Coder session
       fleet box start <box>       Start a stopped box and reconnect its forwards everywhere
       fleet box idle              On a box: exit 0 when it is idle, 1 when it is at work
       fleet box threads           On a box: list the threads that still run or wait for an answer
       fleet box restore           Start the T3 forwards of recorded box links again
       fleet box token             Save a Claude token from standard input for new boxes (claude setup-token makes one)
       fleet box sweep             Stop idle boxes, keep busy ones up, and finish what a crashed operation left (hub, every 15 minutes)
       fleet box reap [--days <n>] [--dry-run]
                                   Delete boxes stopped for n days, hub.boxReapDays by default (hub)
       fleet box pool [list | refresh]
                                   The hub's pool of stopped boxes; refresh starts, cleans, warms and stops
                                   each free box (hub)
       fleet box grant <devbox> [--if-expiring]
                                   Mint a Coder token on the hub and give it to a devbox (hub)
       fleet box nightly           Reap, grant each devbox a token that expires soon, and refresh the pool (hub, nightly)

spawn, start and release change boxes only on the hub. On a devbox they run there over SSH, with --for <this devbox>
so the hub links the box to it.`;

const hubOnly = ["sweep", "reap", "pool", "grant", "nightly"];
const onHub = ["spawn", "start", "release"];
const option = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

function caller(args: string[]): { plain: string[]; devbox?: string; valid: boolean } {
  const at = args.indexOf("--for");
  if (at < 0) return { plain: args, valid: true };
  const devbox = args[at + 1] ?? "";
  const plain = [...args.slice(0, at), ...args.slice(at + 2)];
  return { plain, devbox, valid: onHub.includes(args[0] ?? "") && canBeDevbox(devbox) && !plain.includes("--for") };
}

function valid(args: string[]): boolean {
  const [command, name, ...rest] = args;
  switch (command) {
    case "list": case "idle": case "threads": case "restore": case "token": case "sweep": case "nightly":
      return args.length === 1;
    case "link": case "unlink": case "start":
      return !!name && !rest.length;
    case "release":
      return !!name && rest.every((flag) => ["--force", "--delete"].includes(flag));
    case "spawn":
      return [name, ...rest].filter((arg) => arg !== undefined).every((arg, index) => arg === "--new" || (index === 0 && !arg.startsWith("--")));
    case "run":
      return !!name && isBoxName(name) && rest[0] === "--" && rest.length > 1;
    case "grant":
      return !!name && !name.startsWith("-") && rest.every((flag) => flag === "--if-expiring");
    case "reap":
      return args.slice(1).every((arg, index, all) => arg === "--dry-run" || (arg === "--days" && /^\d+$/.test(all[index + 1] ?? "")) || all[index - 1] === "--days");
    case "pool":
      return (name === undefined || name === "list" || name === "refresh") && !rest.length;
    default:
      return false;
  }
}

export async function boxCommand(args: string[], deps: BoxDeps): Promise<number> {
  const [command] = args;
  if (command === "help" || command === "--help" || command === "-h") return deps.machine().print(usage), 0;
  const here = deps.machine();
  const { plain, devbox, valid: validCaller } = caller(args);
  if (!validCaller || !valid(plain)) return here.print(usage), 2;
  const [, name, ...rest] = plain;
  if (onHub.includes(command!) && !here.isHub) return here.toHub(["box", ...plain, "--for", devbox ?? here.self]);
  if (hubOnly.includes(command!)) requireHub(here.home, command!);
  const coder = () => deps.coder(here);
  const by = devbox ? { devbox } : {};
  const holding = <T>(box: string, step: () => Promise<T>) => (assertBox(box), withBoxLock(here.home, box, lockWait(here, box, userWaitMs), step));
  const grantTo = (devbox: string, ifExpiring: boolean) => grant(coder(), devbox, { ifExpiring, now: here.now(), onDevbox: here.onPeer, print: here.print });
  const reapNow = async (days: number, dryRun: boolean) => {
    const pooled = new Set(registry.pooled(registry.poolFile(here.home)));
    for (const box of ownership(await coder().boxes(), here).skipped) here.print(`${box.name}: skipped, not a box this pool made`);
    const unpooled = { boxes: async () => ownership(await coder().boxes(), here).owned.filter((box) => !pooled.has(box.name)) };
    return reap(unpooled, { days, dryRun, now: here.now(), print: here.print }, async (box, stillStale) => {
      try {
        return await release(coder(), here, box, { force: true, stillDoomed: stillStale, hooks: deps.hooks, waitMs: 0 });
      } catch (error) {
        if (!(error instanceof LockBusy)) throw error;
        here.print(`${box}: another operation holds it; skipped`);
        return 0;
      }
    });
  };
  switch (command) {
    case "token": return await saveToken(here.home, await deps.readStdin()), here.say("saved the Claude token for new boxes"), 0;
    case "idle": return idle(here);
    case "threads": return threads(here);
    case "restore": return restoreForwards(coder(), here);
    case "unlink": return (await holding(name!, () => unlink(here, name!))) ? 0 : 1;
    case "list": return list(coder(), here);
    case "sweep": return sweep(coder(), here, deps.hooks);
    case "pool":
      if (name === "refresh") return refreshPool(coder(), here);
      for (const box of registry.pooled(registry.poolFile(here.home))) here.print(box);
      return 0;
    case "grant": return grantTo(name!, rest.includes("--if-expiring"));
    case "reap": return reapNow(Number(option(plain, "--days") ?? here.settings.reapDays), plain.includes("--dry-run"));
    case "nightly": return nightly(nightlySteps(here, { reap: () => reapNow(here.settings.reapDays, false), grant: (devbox) => grantTo(devbox, true), refresh: () => refreshPool(coder(), here) }), here);
    case "run": return coder().run(name!, `bash -lc ${quote(rest.slice(1).join(" "))}`);
    case "link": return await holding(name!, () => link(coder(), here, name!)), 0;
    case "start": return startBox(coder(), here, name!, by);
    case "spawn": return spawn(coder(), here, name === "--new" ? undefined : name, { reuse: !plain.includes("--new"), ...by });
    default: return release(coder(), here, name!, { force: rest.includes("--force"), recycle: !rest.includes("--delete"), hooks: deps.hooks, ...by });
  }
}
