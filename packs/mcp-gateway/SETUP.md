# Setup note: MCP gateway

Read this when the person picks the MCP gateway in step 9.

The hub runs one MCP gateway. The hub signs in to each MCP server once, and
agents on every machine reach the servers through it. It needs Docker on the
hub, and it starts with no servers.

1. Check that `ssh coder.<hub> 'docker info'` passes. When it fails, stop
   and tell them the hub's template needs Docker.
2. Add `--add mcp-gateway` to the command in step 9, and change
   `mcp-gateway=off` to `mcp-gateway=on`.
3. After the hub's `fleet update`, run `fleet update` on this Mac too.
   It opens the Mac's tunnel to the hub, so agents here reach the gateway.
4. Servers live in `~/.local/share/fleet-mcphub/data/mcp_settings.json`
   on the hub. When a server needs a sign-in, run this on the hub and open
   each address it prints:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet mcp-gateway sign-in'
   ```

   The Mac's hub tunnel from step 3 already forwards the gateway's port, so
   skip the `coder port-forward` line it prints. Run that line only when
   `fleet hub-tunnel doctor` on this Mac fails; a second forward on the same
   port fails while the tunnel runs.

   `fleet mcp-gateway doctor` on the hub says what does not work.

   Some servers accept only a sign-in that returns to `127.0.0.1`, so the
   gateway's own sign-in link fails for them. A pack marks such a server
   with `"loopback": true`; the gateway then registers its own client for
   it, and `sign-in` names a command for it instead of a link. Run that
   command on the hub in a terminal, such as
   `ssh -t coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet mcp-gateway sign-in <name>'`. Open the address
   it prints and sign in. The browser then fails to load a `127.0.0.1` page;
   copy the full address from its address bar and paste it into the
   terminal. The sign-in stays on the hub.

5. The `gmail`, `google-calendar`, and `google-drive` workflows start off.
   They reach Google through the person's ChatGPT sign-in, so the app must
   be connected in ChatGPT first, which Fleet cannot do. In ChatGPT, open
   **Settings**, then **Apps**, and connect the app. In a Business or
   Enterprise workspace, an admin first allows the app in the workspace
   settings, under **Apps**. Then turn the workflow on with
   `--workflows gmail=on`, and run `fleet mcp-gateway sign-in gmail` on the
   hub as in item 4.
