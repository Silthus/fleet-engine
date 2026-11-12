# Page you through incident.io

The incident.io pack lets an agent page you, and only you. Use it when an
agent watches a risky production change for you: you name a tripwire, such
as an error rate or a lag, and the agent pages you when it fires, so you can
undo the change. Nobody on the on-call rotation is paged, and no incident is
declared.

`fleet page` sends one alert event to your own incident.io HTTP alert
source. The alert route on that source escalates to your user directly.

**The route is the only thing that limits the page to you.** The command
knows no people. When someone changes the route, `fleet page` pages whoever
the route names. Check the route before you rely on it.

The workflow, `page-owner`, starts off. Turn it on with
`fleet packs --add incident-io --workflows page-owner=on`. Its
[setup note](../packs/incident-io/SETUP.md) walks through the incident.io
side. While the workflow is off, `fleet page` refuses to run on every
machine, so turning it off stops all pages. The saved source stays.

## Send and withdraw a page

```sh
fleet page --key checkout-rollout-errors \
  --title "Checkout rollout: errors over the tripwire" \
  --description "Undo: switch the rollout flag off. The panel is in the link." \
  --source-url "https://dashboards.example/checkout"

fleet page --key checkout-rollout-errors --resolve
```

- `--key` is the deduplication key, and it is required. incident.io treats
  events with the same key as one alert, so a retry never pages twice. Use
  one key for each tripwire.
- `--resolve` sends status `resolved` for the key. The route's auto-cancel
  withdraws the page.
- A value that starts with a dash goes after an equals sign, such as
  `--description=-5% errors`. Without it, `fleet page` refuses the value, so
  a flag such as `--dry-run` is never taken as text.
- `--dry-run` checks the input and the saved source, prints the event with
  the token hidden, and sends nothing.

The command prints the HTTP status and incident.io's `status`, `message`,
and `errors`. Any 2xx answer means incident.io accepted the event. The live
API answers `202` with status `accepted`, not the `success` that its docs
show. The exit code is 0 when incident.io accepted the event, 1 when it did
not, when the source is not set up, when the hub did not answer, or when the
workflow is off, and 2 on wrong input. How urgently your phone rings comes
from your own notification rules in the incident.io app.

## Where the token lives

`fleet page setup <source URL> < <token file>` saves the URL and the token
in the pack's secret store, `~/.config/fleet/secrets/incident-io/source`,
which only you can read. Fleet refuses a secret file that other users can
read, or that is a link. `fleet page` also
refuses a saved URL that is not
`https://api.incident.io/v2/alert_events/http/<id>`. Plain `http` to a
loopback address is allowed too, for tests against a fake incident.io on the
same machine.

The command sends the token from inside its own process, so it is never on
a command line that `ps` shows. It never prints the token, the URL, or the
source id, also not in an error that incident.io sends back.

## With a hub

`fleet page` is a hub command. With a hub, it always runs on the hub, so the
token lives in one place. On a node or a Mac, `fleet page <flags>` runs on
the hub over SSH and prints the hub's answer. `fleet page setup` sends the
token to the hub on SSH standard input, never on a command line. Rotating
the token changes one file. A hub never forwards the command again.

With Mac only, the command and the token stay on the Mac.

**The hub is a single point of failure.** When SSH cannot reach the hub,
`fleet page` exits 1 and says that ssh to the hub exited 255. When the hub
answers SSH but hangs, the command does not finish. An agent that must not
miss a page treats either as a failed page: it sends it once more, then
tells you another way, such as a Slack message. The pack's instructions tell
agents to do that.

## Risks

- **The alert is visible.** Each event shows in your organization's alert
  list in incident.io, where anyone with access sees its title and
  description. Keep customer data and internal numbers out of them.
- **On-call insights.** A page can count in incident.io's on-call insights
  and reports for you.
- **Slack.** A route or a source that posts to a Slack channel announces
  every page. Check that neither does.
- **The token can page you.** Anyone with the token can page you. To revoke
  it, rotate or delete the alert source in incident.io.
- **Every machine of yours can page.** With a hub, any machine that reaches
  the hub over SSH can page through it. That is the same trust as the hub's
  other services.

## What the pack does not use

- **The Escalations API** (`POST /v2/escalations` with `user_ids`) could page
  a user without a route. It needs an API key with the right to escalate,
  and that key can page anyone in the organization. An alert source token
  can only send events to its own source, and the route decides the rest.
- **The incident.io MCP server** gives an agent the same wide key, with
  every other tool on top. The pack keeps the agent's reach to one source.

## Sources

- [Create an alert event](https://docs.incident.io/api-reference/alert-events-v2/create)
- [Custom HTTP alert sources](https://docs.incident.io/alerts/custom-http-sources)
- [Escalations from alerts](https://docs.incident.io/alerts/escalations-from-alerts)
- [Who is on call](https://docs.incident.io/on-call/determining-on-call)
- [Notifications](https://docs.incident.io/on-call/notifications) and
  [iOS notifications](https://docs.incident.io/on-call/ios-notifications)
- [Seat types](https://docs.incident.io/admin/seat-types)
