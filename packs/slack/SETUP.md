# Setup note: Slack

Read this when the person picks the Slack pack.

Their own Slack message with `:t3code:`, their `:t3code:` reaction, or a
mention of their Slack app starts a T3 thread. It needs their own Slack app.
With Mac only, the trigger runs on the Mac and stops while the Mac sleeps.
Once the Mac has devboxes, the trigger runs only on a named hub, so with a
hub and a node it waits for the Hub pack. Offer Slack only with Mac only.

1. The workflow starts off. Add `--workflows slack-thread=on` to the setup
   command.
2. Setup asks `slack.userId` as a `--set` line. Tell them where to find it:
   in Slack, open their profile, then **More**, then **Copy member ID**.
3. Setup then stops at the Slack app step, which needs their keyboard. Run it
   in a Terminal window, and ask them to tell you when it ends:

   ```sh
   printf '#!/bin/sh\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\nfleet slack-trigger setup\n' > ~/.cache/fleet-setup/slack.command && chmod +x ~/.cache/fleet-setup/slack.command && open ~/.cache/fleet-setup/slack.command
   ```

   It gives a link that creates the app in their workspace, then asks for
   the app's two tokens. Fleet keeps them where only they can read them.

[Start a thread from Slack](https://github.com/Silthus/fleet-engine/blob/main/docs/slack.md)
explains the rest.
