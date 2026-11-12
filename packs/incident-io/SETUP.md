# Setup note: incident.io

Read this when the person picks the incident.io pack, in step 6 with Mac
only or in step 9 with a hub.

An agent that watches a change they name pages them, and only them, through
their own incident.io alert source, with `fleet page`. The alert route on
that source decides who is paged, so most of the setup is in incident.io.
With Mac only, the token lives on the Mac. With a hub, it lives on the hub,
and every other machine pages through it.

[Page you through incident.io](https://github.com/Silthus/fleet-engine/blob/main/docs/incident-io.md)
explains how it works and its risks. Tell them the risks before step 3.

1. The workflow starts off. Add `--workflows page-owner=on` to the setup
   command.
2. **Check the prerequisites.** Ask with your question tool whether they
   have all three. incident.io can page only a user with an **On-call**
   seat.
   - An **On-call** seat on their incident.io user. They do not need to be
     on a rotation: the route names their user directly.
   - The **incident.io app** on their phone, with notifications and
     critical notifications allowed.
   - The **admin** or **on-call editor** role, which can create one alert
     source and one alert route. Without it, an incident.io admin creates
     both for them with the settings in steps 3 and 4.

   An incident.io admin assigns seats and roles. Stop here until they have
   them.
3. **The alert source.** Ask them to open
   <https://app.incident.io/~/on-call/alert-routes/sources/create?source_type=http>
   and create an **HTTP** source named for this, such as "Fleet page". Ask
   them to keep its URL, `https://api.incident.io/v2/alert_events/http/<id>`,
   and its token for step 5.
4. **The alert route.** Ask them to open
   <https://app.incident.io/~/on-call/alert-routes/routes/create>, select
   only the new source under **Receive alerts from**, and set:
   - **Escalate alerts: on**, to their own user directly. Not to an
     escalation path or a schedule that includes the rotation. Without this,
     the alert pages nobody.
   - **Auto-cancel escalations when the alert resolves: on**, so
     `fleet page --resolve` withdraws the page.
   - **Create incidents: off.** The route must never declare an incident.
   - **Send alerts to Slack: off.** Check that neither the route nor the
     source posts to a Slack channel.
5. **Save the source.** Ask for the token with the secret prompt,
   delivered as a file, never in the chat. They can give the URL in the
   chat: it cannot page without the token. Then run, on any machine of
   theirs:

   ```sh
   fleet page setup '<source URL>' < <token file>
   rm -f <token file>
   fleet page --key setup-check --title "Setup check" --dry-run
   ```

   With a hub, run it after the hub's `fleet update`. The command runs on
   the hub, and the token travels on SSH standard input only. The dry run
   checks the saved source, and from another machine the SSH hop to the
   hub. It sends nothing.

   `setup` refuses a URL that is not an incident.io alert events URL, and
   a token that is not one line. Ask for that value again.
6. **Make the phone ring through Do Not Disturb.** In the incident.io app,
   under their notification rules, ask them to:
   - add a **high-urgency** rule that calls or notifies the phone, with the
     **Do Not Disturb bypass** on;
   - on iOS, allow **Critical notifications** for the app;
   - press the app's **Test** button with Do Not Disturb on, and tell you
     whether the phone rang. That proves the bypass without an alert.
7. **The first real page is their call.** Never send one to try the setup.
   When they ask for one, send it, and withdraw it once they confirm:

   ```sh
   fleet page --key setup-check --title "Setup check" --description "A test page they asked for."
   fleet page --key setup-check --resolve
   ```
