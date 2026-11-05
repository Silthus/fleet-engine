import { boxPrefix, grant, reap, type Coder } from "./coder.ts";
import { link, restoreForwards, unlink, type BoxCoder } from "./links.ts";
import { quote, requireHub, type Machine } from "./machine.ts";
import { idle, list, nightly, nightlySteps, ownership, poolAt, poolOn, refreshPool, release, saveToken, spawn, startBox, sweep, threads, type BoxHooks } from "./box.ts";
import * as registry from "./pool.ts";

export type CommandCoder = BoxCoder & Pick<Coder, "env" | "token">;
export type BoxDeps = { machine(): Machine; coder(here: Machine): CommandCoder; readStdin(): Promise<string>; hooks: BoxHooks };

const usage = `Usage: fleet box spawn [<name>] [--new]
                                   Claim a stopped box from the pool, or create box-<name>; set it up like a devbox,
                                   link it to T3 here and on every peer, and print "<box> <environmentId>"
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
       fleet box sweep             Stop idle boxes and keep busy ones up (hub, every 15 minutes)
       fleet box reap [--days <n>] [--dry-run]
                                   Delete boxes stopped for n days, hub.boxReapDays by default (hub)
       fleet box pool [list | refresh]
                                   The hub's pool of stopped boxes; refresh starts, cleans, warms and stops
                                   each free box. Spawn, start and release use its other subcommands over
                                   SSH: claim, own, reserve, hold, unhold, give and drop (hub)
       fleet box grant <devbox> [--if-expiring]
                                   Mint a Coder token on the hub and give it to a devbox (hub)
       fleet box nightly           Reap, grant each devbox a token that expires soon, and refresh the pool (hub, nightly)`;

const hubOnly = ["sweep", "reap", "pool", "grant", "nightly"];
const poolArity: Record<string, [number, number]> = { list: [0, 0], claim: [0, 0], refresh: [0, 0], own: [2, 2], reserve: [1, 1], hold: [2, 3], unhold: [2, 2], give: [2, 2], drop: [1, 1] };
const reserveCodes = { reserved: 0, held: 3, busy: 4 };
const holdCodes = { held: 0, stale: 3, unowned: 4 };
const option = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

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
      return !!name?.startsWith(boxPrefix) && rest[0] === "--" && rest.length > 1;
    case "grant":
      return !!name && !name.startsWith("-") && rest.every((flag) => flag === "--if-expiring");
    case "reap":
      return args.slice(1).every((arg, index, all) => arg === "--dry-run" || (arg === "--days" && /^\d+$/.test(all[index + 1] ?? "")) || all[index - 1] === "--days");
    case "pool": {
      if (name === undefined) return true;
      if (!Object.hasOwn(poolArity, name)) return false;
      const [least, most] = poolArity[name]!;
      return rest.length >= least && rest.length <= most && rest.every((arg, index) => (index === 0 ? /^box-[a-z0-9][a-z0-9-]*$/ : /^[\w-]*$/).test(arg));
    }
    default:
      return false;
  }
}

async function poolCommand(coder: () => CommandCoder, here: Machine, [verb = "list", box = "", value = "", claim]: string[]): Promise<number> {
  const file = registry.poolFile(here.home);
  const pool = poolAt(file, here.settings.poolSize);
  switch (verb) {
    case "own": return here.print(await pool.own(box, value)), 0;
    case "claim": {
      const claimed = await pool.claim();
      if (claimed) here.print(`${claimed.box} ${claimed.id} ${claimed.claim}`);
      return claimed ? 0 : 3;
    }
    case "reserve": {
      const reserved = await pool.reserve(box);
      if (reserved.state === "reserved") here.print(reserved.claim);
      return reserveCodes[reserved.state];
    }
    case "hold": {
      const held = await pool.hold(box, value, claim);
      if (held.state === "held") here.print(held.token);
      return holdCodes[held.state];
    }
    case "unhold": return await pool.unhold(box, value), 0;
    case "give": return (await pool.give(box, value)) ? 0 : 3;
    case "drop": return await pool.drop(box), 0;
    case "refresh": return refreshPool(coder(), here);
    default:
      for (const name of registry.pooled(file)) here.print(name);
      return 0;
  }
}

export async function boxCommand(args: string[], deps: BoxDeps): Promise<number> {
  const [command, name, ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h") return deps.machine().print(usage), 0;
  const here = deps.machine();
  if (!valid(args)) return here.print(usage), 2;
  if (hubOnly.includes(command!)) requireHub(here.home, command!);
  const coder = () => deps.coder(here);
  const grantTo = (devbox: string, ifExpiring: boolean) => grant(coder(), devbox, { ifExpiring, now: here.now(), onDevbox: here.onPeer, print: here.print });
  const reapNow = (days: number, dryRun: boolean) => {
    const pooled = new Set(registry.pooled(registry.poolFile(here.home)));
    for (const box of ownership(coder().boxes(), here).skipped) here.print(`${box.name}: skipped, not a box this pool made`);
    const unpooled = { boxes: () => ownership(coder().boxes(), here).owned.filter((box) => !pooled.has(box.name)) };
    return reap(unpooled, { days, dryRun, now: here.now(), print: here.print }, (box, stillStale) => release(coder(), here, box, { force: true, stillDoomed: stillStale, pool: poolOn(here), hooks: deps.hooks }));
  };
  switch (command) {
    case "token": return await saveToken(here.home, await deps.readStdin()), here.say("saved the Claude token for new boxes"), 0;
    case "idle": return idle(here);
    case "threads": return threads(here);
    case "restore": return restoreForwards(coder(), here);
    case "unlink": return unlink(here, name!) ? 0 : 1;
    case "list": return list(coder(), here);
    case "sweep": return sweep(coder(), here, deps.hooks);
    case "pool": return poolCommand(coder, here, args.slice(1));
    case "grant": return grantTo(name!, rest.includes("--if-expiring"));
    case "reap": return reapNow(Number(option(args, "--days") ?? here.settings.reapDays), args.includes("--dry-run"));
    case "nightly": return nightly(nightlySteps(here, { reap: () => reapNow(here.settings.reapDays, false), grant: (devbox) => grantTo(devbox, true), refresh: () => refreshPool(coder(), here) }), here);
    case "run": return coder().run(name!, `bash -lc ${quote(rest.slice(1).join(" "))}`);
    case "link": return await link(coder(), here, name!), 0;
    case "start": return startBox(coder(), here, name!, poolOn(here));
    case "spawn": {
      const label = name === "--new" ? undefined : name;
      return spawn(coder(), here, label, poolOn(here), !args.includes("--new"));
    }
    default: return release(coder(), here, name!, { force: rest.includes("--force"), recycle: !rest.includes("--delete"), pool: poolOn(here), hooks: deps.hooks });
  }
}
