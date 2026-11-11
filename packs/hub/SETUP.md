# Setup note: Hub

Read this in step 9 of the guide, once the hub is named with
`fleet hub here`.

The Hub pack makes the hub keep SSH tunnels and T3 links to every devbox
open, and clean a devbox whose disk runs low. Turn it on from the Mac, with
the hub's SSH name:

```sh
fleet packs --add hub --workflows boxes=off --set hub.alias=coder.<hub>
```

Then move the hub to the new profile:

```sh
ssh coder.<hub> 'bash -lc "fleet update && fleet doctor"'
```

**Boxes** start off here. With boxes on, an agent borrows a short-lived
devbox from a warm pool for a big job, and the pool keeps up to 8 stopped
workspaces in their Coder account. Tell the person, and turn boxes on only
when they ask:

```sh
fleet packs --workflows boxes=on --set hub.coderUrl=<coder address> --set hub.boxTemplate=<template>
```

`fleet packs` lists the hub's other workflows, such as `dream`, which are
off until they turn them on.
