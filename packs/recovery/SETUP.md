# Setup note: Recovery

Read this when the person picks Recovery in step 9.

A thread that stops on a usage limit or a provider outage continues by
itself once the provider answers again. Recovery asks the provider through
the hub's own-account proxy, so it needs own-account balancing. Without it,
Recovery never knows that a provider has capacity, and continues nothing.

1. Add `--add recovery` to the command in step 9, and add
   `provider-recovery=on,own-account-balancing=on` to `--workflows`.
2. After the hub's `fleet update`, the proxy needs at least two of their
   own subscriptions. This prints the sign-in command that adds one:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet cli-proxy plan'
   ```

   The sign-in needs their keyboard and browser, so run the printed
   command in a Terminal window as `ssh -t coder.<hub> '<command>'`, once
   for each subscription, and follow what it prints.
3. After step 9 adds the node, connect it to the proxy. On the hub,
   `fleet cli-proxy doctor` prints one `Connect <node>:` command per node.
   Each one reads the hub's proxy key, so it runs on the hub, not on this
   Mac:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet cli-proxy doctor'
   ```

   Then run each `Connect` command it printed on the hub, without the
   `Connect <node>:` label:

   ```sh
   ssh coder.<hub> sh -s <<'SCRIPT'
   export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
   <the command after Connect <node>:>
   SCRIPT
   ```
