# Secret store

`fleet secret` keeps each credential once, on the Fleet hub. An agent on any
machine runs a command with it through `fleet secret run`. The value goes into
that command's environment only. It is never written to the agent's disk, and
its exact text is removed from the command's output. The Hub pack brings the
command. Without a hub (`hub.alias` unset), the store lives on this machine.

## Kinds

- **Standing**: a declared row without its own file. Every lane reuses it. Its
  store expiry is at most 90 days after the put.
- **Existing**: a declared row with its own file, a secret the hub held before
  the store. It keeps its own file and renewal steps, and has no store expiry.
  `put` refuses it.
- **Live handoff**: an OAuth callback, a literal `confirm`, or a token that
  lasts under a day. It is asked for at use time and never enters the store.

## Rows and providers

The store holds no row of its own. Packs and the profile declare them through
two handler seams in `pack.json`:

- `secret-rows`: a module that exports `rows(provider)`. It returns the rows:
  name, provider, scope, project, region, settings link, variables, and for an
  existing secret its file. No values.
- `secret-providers`: a module that exports `providers`, a map from a provider
  name to a function that takes the row's options and returns the provider.
  A provider owns a secret's shape rule and its read-only live check. The check
  runs in process with the values, so no value reaches an argv.

`provider(name, options)` in a rows module returns that provider. When no pack
on the hub brings it, the provider's check refuses every put, so a value is
never stored unchecked.

```ts
export const rows = (provider) => [
  { name: "example-send", provider: provider("example-key", { project: "12" }), scope: "email:write", project: "12", region: "us",
    settings: "https://example.com/settings/keys", env: ["EXAMPLE_API_KEY"] },
  { name: "chat-app", provider: { name: "chat-app" }, scope: "the chat app's tokens", settings: "https://example.com/apps",
    env: ["CHAT_BOT_TOKEN"], file: { path: ".config/fleet/chat-app.json", format: "json", fields: { botToken: "CHAT_BOT_TOKEN" }, renew: "the chat pack's setup" } },
];
```

A check answers `{ ok: true }`, `{ ok: true, unchecked: "<what it could not prove>" }`,
or `{ ok: false, reason: "<why>" }`. A reason never repeats a value.

## Use a secret

```sh
fleet secret list
fleet secret run example-send -- <command>
```

- `list` shows each secret's kind, provider, project, region, scope and state.
  It never shows a value. For an existing secret it reads only the file's
  metadata, so it works while the store is off.
- `run <name>... -- <command>` sets each secret's variables in the command's
  environment. It replaces each value in the command's stdout and stderr with
  `[redacted <name>]` (`[redacted]` when that label would spell a value), and
  exits with the command's code. A line whose redaction would still show a
  value is withheld whole. A value that the command encodes, splits, or writes
  to a file is not redacted. Pass credentials through the environment or stdin,
  never argv.
- `run` refuses when the store is off, a name is unknown, its value is missing
  or past its store expiry, or two names set the same variable.
- `list --need <name>...` prints, for each named secret that is missing or
  fails its live check, the text of the `request_secret` card to ask the user
  with. The checks run on the hub, and each appends a read event marked
  `check`. A check that throws counts as failing, and its message is not
  shown. An `off` that lands during a check stops the rest and withholds the
  answers.
- `list --due` names each secret within 7 days of its expiry, past it, or
  missing, with the same card text.

## Put a secret

1. Ask the user with a `request_secret` card with `delivery: "file"`. For a
   secret with more than one variable, the card asks for one `VAR=value` line
   per variable.
2. Run `fleet secret put <name> --file <the saved file>`.

`put` takes only a file in T3's secret-file directory
(`~/.t3/userdata/secrets/files`). It deletes the file on success, on failure
and on an interrupt, and never prints it. A value is one line of at least 8
characters. A value that the put's own record or `list` line would spell is
refused. A new value replaces the stored one only after the check passes; on
failure the old value stays.

`--expires <date>` is the provider's expiry: a real calendar date such as
`2026-12-31`, or a time with its zone such as `2026-12-31T18:00Z`. A past date,
or one more than 90 days out, is refused. The store expiry is the earlier of the provider's expiry
and 90 days after the put. `--why` names a late reason: `intake` (the default),
`failed-check`, `expired`, `revoked`, `scope`, or `missed`.

## Stop every read

```sh
fleet secret off "suspected leak in <thread>"
fleet secret on --words '2026-11-13 "Turn it back on"' --thread <id>
```

Any agent may turn the store off. To turn it on, ask the user with the
question tool: "Turn the secret store back on?", with the options "Yes, turn it
on" and "No, keep it off". Only a yes to that question in the given T3 thread,
given after the store went off, turns it on, and each answer turns it on once.
`off --help` prints the usage, and `off` refuses a reason that starts with `-`.

A line of the event log that is not JSON, or an `off` line without its fields,
counts as an `off`: an interrupted `off` keeps the store off. The user's yes
turns it on as for any other `off`.

## Threat model

The store guards against accidental exposure: a value in a transcript, in tool
output, or on a devbox's disk. A failure that is not a refusal prints a fixed
message, never the error's own text, and a caller never shows the hub's
stderr. It does not guard against the hub's own user
reading a value file, or a value that a command encodes, splits, or writes to a
file. After a suspected leak, run `off` first, then rotate the secret at its
settings link.

## On the hub

- Values: `~/.config/fleet/secrets/<name>.<put id>` (0600, in a 0700
  directory). Each put writes a new file; none is rewritten.
- Event log: `~/.local/state/fleet/secrets.jsonl`, one JSON line per put, read,
  off and on, never a value.

Other machines send one JSON request to `fleet secret hub` over SSH stdin and
read one JSON answer on stdout, so a value never reaches a command line. The hub
is the only reader of value files, so the switch and the read log cover every
store read.

The hub trusts the caller's report of the user's answer, as the decision
ledger does. An agent that can reach the hub over SSH can read its files, so a
check on the hub would not stop a hostile agent; the store guards against
mistakes. Each change is one append to the log, and the order of the log
decides: an `on` checks the log again after its append and stays off when a
newer `off` landed.
