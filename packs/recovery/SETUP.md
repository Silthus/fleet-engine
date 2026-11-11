# Setup note: Recovery

Read this when the person picks Recovery in step 9.

A thread that stops on a usage limit or a provider outage continues by
itself once the provider answers again. Recovery asks the provider through
the hub's own-account proxy, so it needs own-account balancing. Without it,
Recovery never knows that a provider has capacity, and continues nothing.

1. Add `--add recovery` to the command in step 9, and add
   `provider-recovery=on,own-account-balancing=on` to `--workflows`.
2. After the hub's `fleet update`, the proxy needs their own
   subscriptions. This prints the command that adds each one. Its sign-ins
   need their keyboard, so run it in a Terminal window as
   `ssh -t coder.<hub>` with the same `PATH` line:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet cli-proxy plan'
   ```

3. Then `fleet cli-proxy doctor` on the hub prints a connect command for
   each node. Run each one on this Mac.
