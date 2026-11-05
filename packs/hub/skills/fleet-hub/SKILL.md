---
name: fleet-hub
description: Manage your machines from the Fleet hub. Use to roll out a profile or engine change to every machine, to change one machine, or to look up which machines Fleet manages.
---

# Fleet hub

The hub is the devbox whose `~/.config/fleet/machine.json` has `"role": "hub"`.
It reaches every devbox over SSH and the Mac through its T3 link. Make each
change in the profile, push it, and roll it out from the hub.

## The machines

- **The hub**: this machine. `fleet hub status` prints its role and
  `hub.alias`, the SSH name other machines use for it.
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
