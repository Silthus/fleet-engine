---
name: fleet-hub
description: Manage your machines from the Fleet hub. Use to roll out a profile or engine change to every machine, to change one machine, or to look up which machines Fleet manages.
---

# Fleet hub

The hub is the devbox that the profile's `hub` names (`fleet hub here`).
It reaches every devbox over SSH and the Mac through its T3 link. Make each
change in the profile, push it, and roll it out from the hub.

## The machines

- **The hub**: this machine. `fleet hub status` prints this machine's name
  and the hub that the profile names. `hub.alias` is the SSH name other
  machines use for it.
- **Devboxes**: the `devboxes` list in the profile's `fleet.json`, plus the
  ones `fleet devbox` lists on the hub, without duplicates. Reach each one by
  its SSH name.
- **The Mac**: a T3 environment link on the hub. `t3_environment_links`
  lists it.
- **Boxes**: short-lived devboxes from the pool. `fleet box list` lists them.
  Leave them out of a rollout.

`profileDir` in `~/.config/fleet/machine.json` names the profile checkout.

## Roll out a change

1. **Push.** Commit the profile change in the profile checkout and push it.
   An engine change needs no commit here: it reaches a machine through
   `fleet update` once it is on the engine's main branch, or in a release for
   the release channel. Done when `git status` in the profile checkout is
   clean and its branch matches its remote.
2. **Hub.** Run `fleet update`, then `fleet doctor`. Done when both exit 0.
3. **Devboxes.** For each devbox in turn, run the same two commands in a
   login shell over SSH, with a total limit of 10 minutes:

   ```sh
   timeout 600 ssh -o BatchMode=yes -o ConnectTimeout=10 <devbox> 'f="$HOME/.local/share/fleet/engine/fleet"; bash -lc "sh $f update && sh $f doctor"'
   ```

   Done when each devbox has exited 0 or has a failure to report.
4. **Mac.** Find the Mac with `t3_environment_links`. Call `t3_thread_launch`
   with its `environmentId`, `scratch: true`, `runtimeMode` `full-access`,
   and a prompt that runs `fleet update`, then `fleet doctor`, stops at the
   first failure, and reports each exit code and every `To do:` line. Wait
   with `t3_thread_wait`. Done when the thread answered, or when the link is
   missing, expired, or timed out: then report the Mac as pending with the
   reason.
5. **Report** one line per machine: updated and verified, pending, or the
   failure with its last output line. Relay every `To do:` line; those are
   steps only the person can do. Done when every machine from **The
   machines**, boxes aside, has a line.

### When a step fails

- **Unreachable devbox:** report it as pending. It takes the change on its
  next `fleet update`.
- **Out of time:** the command exits 124 when a devbox takes longer than 10
  minutes. Report it as failed with "timed out after 10 minutes" and go on to
  the next devbox. Do not wait for it or run it again.
- **`fleet update` refuses:** the engine checkout has local changes, or the
  profile did not fast-forward. Report the line it printed and skip that
  machine.
- **`fleet apply` conflicts:** a file Fleet wants exists with other content.
  Report each path and wait for the person: adopting discards that content,
  so only they decide. Apply their answer with `fleet apply --adopt <path>`.

When you start outside the hub, start a T3 thread on the hub that runs these
steps.

## Change one machine

Put shared setup in the profile and roll it out. Keep a value for one machine
in that machine's own local files, outside the profile. To add a devbox, run
`fleet devbox add <ssh name>` on the hub: it sets the host up as a devbox and
lists it.

## Own-account balancing

This workflow is off by default. Read its terms note first:
`fleet packs` lists it while the Hub pack is on, and prints it again when the
person turns the workflow on with
`fleet packs --workflows own-account-balancing=on`. Only the person does that. Balancing is only for
the person's own subscriptions, never for someone else's.

- **The proxy.** On the hub, `fleet apply` runs `fleet cli-proxy install`.
  It installs the pinned CLIProxyAPI release, checks its SHA-256, and runs it
  as the user service `fleet-cli-proxy.service` at `http://127.0.0.1:8317`,
  loopback only. Its files are in `~/.local/share/fleet-cli-proxy/`. The
  client key is in `~/.config/fleet/cli-proxy.key` and the management key in
  `~/.local/share/fleet-cli-proxy/management.env`, both mode 600. Install
  keeps a file that Fleet did not write and stops at a linked path.
- **Subscriptions.** The person adds each of their own Claude accounts on the
  hub, or their Codex accounts on the `codex` plan. `fleet cli-proxy doctor`
  prints the login command until the proxy holds `hub.proxyAccounts` of them
  (2 by default). On the `both` plan it counts Claude subscriptions and names
  the Codex ones beside them. Keep the login URL and callback values out of
  logs and Git.
- **The balancer.** Every 5 minutes, `fleet cli-proxy-balance` reads the weekly
  usage of each subscription and gives the highest priority to the one whose
  weekly quota resets first. A full or unreadable subscription gets priority
  0. It keeps fill-first routing, and session affinity keeps each session on
  one subscription. `fleet cli-proxy-balance --dry-run` prints the ranking and
  changes nothing.
- **Claude Code.** On the `claude` and `both` plans, on the hub and on each
  devbox, Fleet sets `env.ANTHROPIC_BASE_URL` to the proxy and `apiKeyHelper`
  to a command that reads the client key file. The key is never in the
  settings file.
- **Codex.** On the `codex` and `both` plans, Fleet sets Codex's
  `model_provider` to `fleet-proxy`, a provider that reads the same key file.
- **Devboxes.** The hub's SSH tunnel to each devbox carries port 8317. On the
  hub, `fleet cli-proxy doctor` prints one connect command per devbox; it
  sends the key on standard input. Boxes get the key and connect when the hub
  hands them over.
- **When the proxy is down.** Fleet's Claude settings wait for
  `fleet cli-proxy check`, and its Codex settings wait for
  `fleet cli-proxy check codex`. Both checks only read. When the proxy does
  not serve an agent with this machine's key, `fleet apply` leaves that
  agent's settings out and removes Fleet's own values, so the agent uses its
  own sign-in, and the next apply changes nothing. `fleet apply` and
  `fleet doctor` name the failed check. The first apply after the proxy
  answers again sends the agent back to the proxy.
- **The panel.** The Proxy panel workflow is off by default and needs
  own-account balancing. With
  `fleet packs --workflows proxy-panel=on`, `fleet cli-proxy install` adds
  the pinned CLIProxyAPI management panel with quota history charts, drain
  forecasts, and Reset weekly and Reset Fable buttons, and the quota-ledger
  plugin that keeps `hub.proxyHistoryDays` of history (35 by default). Both
  downloads must match their SHA-256. The balancer then records each
  subscription's quota windows in the ledger on every run. The panel is at
  `http://127.0.0.1:8317/management.html` on the hub, and on each devbox
  through its tunnel; it is never behind the hub's HTTPS. Sign in with the
  `MANAGEMENT_PASSWORD` in `~/.local/share/fleet-cli-proxy/management.env` on
  the hub. A reset button spends a banked reset, which does not come back:
  the first click arms it, and a second click within 5 seconds spends it.
  Fleet owns `config.yaml`, so a panel edit to it lasts until the next
  `fleet apply`. Turning the workflow off first restarts the proxy with the
  panel closed, then removes the page and the pinned plugin and keeps the
  history file. `fleet cli-proxy doctor` fails while a closed panel still
  answers, when the page does not match its pin (CLIProxyAPI may have
  fetched an unpinned one), and on any plugin Fleet did not install: with
  plugins on, anyone with the management key can install others from
  CLIProxyAPI's plugin store. Turning the panel off keeps those and names
  them. Every tunnelled client reaches the proxy as 127.0.0.1, so 5 wrong
  panel sign-ins from any devbox ban 127.0.0.1 from the management API for
  30 minutes. That also stops the balancer and the doctor on the hub until
  the ban ends.
- **Stop on one machine.** `fleet cli-proxy disconnect` removes the settings
  and the key. Then run `claude` and enter `/login`.
