# MCPHub approval forwarding patch

Base: samanhappy/MCPHub v1.1.0, commit `7d7df2599b0361b2b0238ff3f4e6c0f162da0943`. MCPHub is licensed under the Apache License 2.0. `1.1.0-elicitation.patch` changes two of its source files and is a derivative work under that license.

The unpatched gateway returned `-32601` for upstream `elicitation/create`. The patch advertises form and URL elicitation, forwards the request and its response through the originating downstream MCP request, and forwards URL completion to that same caller.

The upstream MCP connection supplies no caller identifier on these requests. Each shared connection therefore queues tool calls. Cancellation and uncertain failures close the connection before releasing that queue, so a late approval cannot reach another client. The next caller uses MCPHub's existing coalesced reconnection path. Retired queued calls and recoverable HTTP 401/404 failures use that same path. Timeouts are not replayed. Connection retirement checks the live server entry because a scoped reload can replace its original object. Unsupported clients return an error; the gateway never accepts an approval on their behalf.

`fleet mcphub install` downloads the pinned source archive, checks its SHA-256, applies `1.1.0-elicitation.patch`, compiles with upstream's TypeScript compiler from the pinned official image, then layers the two compiled files onto that image. Third-party source is not copied into Fleet. The local image tag includes the patch and the SDK package and lockfile hashes.

The image's MCP client, core, server and legacy server packages are replaced by pinned 2.3.1 packages from `sdk/`, installed with its frozen pnpm lockfile. The Node transport is 2.1.1, the newest release that accepts server 2.3. Express is 4.22.3 and Hono is 4.13.14. The rest of the official image stays pinned by digest.

`sdk/package.json` overrides five transitive packages with exact patched versions, because the direct pins alone can still resolve vulnerable releases:

- `zod` 4.6.7, inside the SDK's `^4.2.0` range;
- `qs` 6.16.1 and `body-parser` 1.20.9, inside the ranges of Express 4.22.3;
- `ip-address` 10.7.5, inside the range of `express-rate-limit`;
- `@hono/node-server` 2.1.5. Node transport 2.1.1 asks for `^1.19.9`, but every 1.x release from 1.19.10 is vulnerable. Node transport 2.1.2 accepts `^2.1.3` with an identical `dist/`, and the transport calls only `getRequestListener`.

These versions fix:

- [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h): OAuth client credential disclosure in the official image's SDK 2.1.0;
- [GHSA-jm63-cq47-j5jp](https://github.com/advisories/GHSA-jm63-cq47-j5jp): a shared server transport delivered one client's messages to another;
- [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453): one request could exhaust server memory during validation;
- [GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq): server bearer authentication accepted tokens issued for another resource;
- [GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw): client transports and OAuth requests followed cross-origin redirects with credentials;
- [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7) and [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f): `serveStatic` decoded the path twice in Hono and `@hono/node-server`;
- [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828): `body-parser` denial of service;
- [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): `zod` memory exhaustion;
- [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26), [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g), [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) and [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw): `qs` denial of service and array-limit bypass;
- [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5): `ip-address` quadratic-time parsing.
