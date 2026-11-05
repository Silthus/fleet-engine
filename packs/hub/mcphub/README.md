# MCPHub approval forwarding patch

Base: samanhappy/MCPHub v1.1.0, commit `7d7df2599b0361b2b0238ff3f4e6c0f162da0943`. MCPHub is licensed under the Apache License 2.0. `1.1.0-elicitation.patch` changes two of its source files and is a derivative work under that license.

The unpatched gateway returned `-32601` for upstream `elicitation/create`. The patch advertises form and URL elicitation, forwards the request and its response through the originating downstream MCP request, and forwards URL completion to that same caller.

The upstream MCP connection supplies no caller identifier on these requests. Each shared connection therefore queues tool calls. Cancellation and uncertain failures close the connection before releasing that queue, so a late approval cannot reach another client. The next caller uses MCPHub's existing coalesced reconnection path. Retired queued calls and recoverable HTTP 401/404 failures use that same path. Timeouts are not replayed. Connection retirement checks the live server entry because a scoped reload can replace its original object. Unsupported clients return an error; the gateway never accepts an approval on their behalf.

`fleet mcphub install` downloads the pinned source archive, checks its SHA-256, applies `1.1.0-elicitation.patch`, compiles with upstream's TypeScript compiler from the pinned official image, then layers the two compiled files onto that image. Third-party source is not copied into Fleet. The local image tag includes the patch and the SDK package and lockfile hashes.

The image's MCP client, core, server and legacy server packages are replaced by pinned 2.2.0 packages from `sdk/`, installed with its frozen pnpm lockfile. The compatible Node transport remains 2.1.0. This fixes [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h), an OAuth client credential disclosure issue in the official image's SDK 2.1.0. The rest of the official image stays pinned by digest.
