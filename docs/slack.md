# Start a thread from Slack

The Slack pack starts a T3 thread from Slack in three ways:

- your own message with the emoji `:t3code:`, which then is the task;
- a mention of your Slack app, such as `@T3Code - Nora Example`, which also is
  the task;
- your own `:t3code:` reaction to any message, which asks the thread to find
  the cause of the problem in that message and propose the fix.

Only your own Slack member ID, the setting `slack.userId`, counts. A message or
reaction from anyone else starts nothing.

## How it works

The trigger runs all the time as a Fleet service, `fleet run
slack/slack-trigger`: a systemd user service `fleet-slack-trigger` on Linux, or
the launchd agent `dev.fleet.slack-trigger` on a Mac. Fleet installs it only
after you save your Slack app. It runs on your hub when the Hub pack is
on. Without the Hub pack, it runs on your only machine, when your profile lists
no devboxes and the machine is not a devbox. A profile that two machines share
without a hub, such as two Macs, runs it on both, and each starts a thread for
the same message. Turn on the Hub pack in that case.

The trigger holds a Socket Mode connection to your own Slack app, so Slack
sends each event within a second, and no address is public.

1. Slack sends every message and reaction in your channels. The trigger keeps
   only your own.
2. It reads the whole Slack thread with your user token and starts a thread
   with the model of the `implementation` row of your model table:
   - with the Boxes workflow of the Hub pack on, on the next box from the pool
     (`fleet box spawn`);
   - otherwise, in a scratch folder on this machine's T3 Code.

   The prompt quotes the Slack thread as data. Only your message is the task,
   and the thread asks you before anything other people see.
3. It reacts with `:eyes:` as you and posts an ephemeral reply, which only you
   see, with the thread's link on `app.t3.codes`.
4. A failed launch retries every minute for a day, with the same command ID,
   so T3 starts one thread even when an answer got lost. On a box, the retries
   go to the same box, and Fleet releases that box when it gives up. You get
   one ephemeral reply about it.

`~/.local/state/fleet/slack/slack-trigger.json` keeps the handled messages for 31
days, so each message starts one thread. The log is
`~/.local/state/fleet/jobs/slack-trigger.log`.

## Set up the Slack app

Each person makes their own app. Its name, `T3Code - <name>`, comes from your
Git name, which Fleet sets from your GitHub account.

`fleet setup` walks you through it when you turn on Start a thread from Slack.
To do it later, or again, run `fleet slack-trigger setup` on the machine that
runs the trigger:

1. Open the link it shows. It makes the app from the manifest in your
   workspace.
2. Under **Basic Information**, add an app-level token with the
   `connections:write` scope, and paste it. It starts with `xapp-`.
3. Under **Install App**, install the app. A workspace admin may need to
   approve it.
4. Copy the **User OAuth Token**, and paste it. It starts with `xoxp-`.

The terminal does not show what you paste. Fleet checks each token with Slack,
and checks that the user token is yours. Then it saves both tokens in the Slack
pack's secret store, `~/.config/fleet/secrets/slack/app`, readable only by
you, and applies your profile, which installs the trigger. A running trigger
checks the saved app every minute. When it changes, the trigger finishes the
launches it already started, stops, and the service starts it again with the
new tokens. `fleet setup --non-interactive` skips this step and lists it as
still needed.

`fleet doctor` lists the setup as a To do until the Slack app is saved.
`fleet slack-trigger check` checks with Slack that the saved user token is
yours. `fleet slack-trigger manifest` prints the manifest itself.

To mention the app in a channel, invite it there first. Messages and reactions
work in every channel you are in, without the app.
