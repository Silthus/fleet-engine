# Setup note: Slack

Read this when the person picks the Slack pack, in step 6 with Mac only or
in step 9 with a hub.

Their own Slack message or reaction with their trigger emoji (default
`:t3code:`, set by `slack.emoji`), or a mention of their Slack app, starts a
T3 thread. It needs their own Slack app.
With Mac only, the trigger runs on the Mac and stops while the Mac sleeps.
With a hub, the trigger runs on the hub, so it runs while the Mac sleeps,
and the Slack app step below runs on the hub.

1. The workflow starts off. Add `--workflows slack-thread=on` to the setup
   command.
2. Setup asks `slack.userId` as a `--set` line. Tell them where to find it:
   in Slack, open their profile, then **More**, then **Copy member ID**.
3. Setup then stops at the Slack app step, which needs the app's two
   tokens. Make the app and take the tokens in the chat, not in Terminal:

   1. Get the link that creates the app in their workspace. It is on the
      first line that this command prints:

      ```sh
      fleet slack-trigger manifest
      ```

      Give them the link, and ask them to pick their workspace and create
      the app.
   2. Ask them to generate an app-level token with the `connections:write`
      scope, under **Basic Information**, then **App-Level Tokens**. Ask for
      it with the secret prompt, delivered as a file.
   3. Ask them to install the app under **Install App**, and to copy the
      **User OAuth Token** from the same page. Ask for it with the secret
      prompt, delivered as a file.
   4. Give both tokens to setup on its standard input, the app-level token
      first:

      ```sh
      printf '%s\n%s\n' "$(cat <app token file>)" "$(cat <user token file>)" | fleet slack-trigger setup
      ```

   With a hub, run both commands on the hub instead, after the hub's
   `fleet update`:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet slack-trigger manifest'
   printf '%s\n%s\n' "$(cat <app token file>)" "$(cat <user token file>)" | ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet slack-trigger setup'
   ```

   It checks each token with Slack, and keeps them where only they can
   read them. When a token is wrong, it says which one and why, and ends
   with code 130 without saving either. Ask for that token again, and give
   both to setup again.

[Start a thread from Slack](https://github.com/Silthus/fleet-engine/blob/main/docs/slack.md)
explains the rest.
