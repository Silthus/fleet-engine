# Setup note: Hub

Read this when the person picks the Hub pack in step 9.

The hub is the one devbox that looks after the others. With the Hub pack
on, it keeps an SSH tunnel and a T3 link to every node, so each machine can
start threads on the others, and it cleans a node's disk before it fills.
Every machine keeps working when the hub is down.

1. Turn it on with `--add hub`. Keep `boxes=off` in `--workflows`.
   Boxes lend short-lived devboxes from a warm pool, and need a Coder
   template, a pool of stopped workspaces, and more setup than a first day
   needs. Turn them on later with `fleet packs --workflows boxes=on`.
2. The hub must already be named in the profile. Step 9 does that with
   `fleet hub here` before it turns the pack on.
3. Own-account balancing and Dream start off. Recovery needs own-account
   balancing, so `packs/recovery/SETUP.md` turns it on when they pick
   Recovery.
4. Each node joins when `fleet devbox add` adds it. The hub takes the new
   node at its next `fleet update`, or at once when it answers.
