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
   each address it prints, with the forward it names running on the Mac:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet mcp-gateway sign-in'
   ```

   `fleet mcp-gateway doctor` on the hub says what does not work.
