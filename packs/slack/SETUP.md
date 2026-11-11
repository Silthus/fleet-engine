# Setup note: Slack

Read this when the person picks the Slack pack, in step 6 with Mac only or
in step 9 with a hub.

Their own Slack message with `:t3code:`, their `:t3code:` reaction, or a
mention of their Slack app starts a T3 thread. It needs their own Slack app.
With Mac only, the trigger runs on the Mac and stops while the Mac sleeps.
With a hub, the trigger runs on the hub, so it runs while the Mac sleeps,
and the Slack app step below runs on the hub.

1. The workflow starts off. Add `--workflows slack-thread=on` to the setup
   command.
2. Setup asks `slack.userId` as a `--set` line. Tell them where to find it:
   in Slack, open their profile, then **More**, then **Copy member ID**.
3. Setup then stops at the Slack app step, which needs their keyboard. Run it
   in a Terminal window, and ask them to tell you when it ends:

   ```sh
   printf '#!/bin/sh\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\nfleet slack-trigger setup\n' > ~/.cache/fleet-setup/slack.command && chmod +x ~/.cache/fleet-setup/slack.command && open ~/.cache/fleet-setup/slack.command
   ```

   With a hub, run it on the hub instead, after the hub's `fleet update`:

   ```sh
   cat > ~/.cache/fleet-setup/slack.command <<'SCRIPT'
   #!/bin/sh
   exec ssh -t coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet slack-trigger setup'
   SCRIPT
   chmod +x ~/.cache/fleet-setup/slack.command && open ~/.cache/fleet-setup/slack.command
   ```

   It gives a link that creates the app in their workspace, then asks for
   the app's two tokens. Fleet keeps them where only they can read them.

[Start a thread from Slack](https://github.com/Silthus/fleet-engine/blob/main/docs/slack.md)
explains the rest.
