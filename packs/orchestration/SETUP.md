# Setup note: Orchestration

Read this when the person picks the Orchestration pack.

**Maps** and **side threads** work with defaults. A map is one issue that
lists tickets; a conductor thread starts one worker thread per ticket. Maps
live in the issues of their `fleet-profile` repo unless they name another
repo with `--set orchestration.tracker=<owner/name>`.

Three workflows run by themselves on a schedule and start off:
`quality-loop`, `signal-loop`, and `pr-digest`. Each runs once per fleet, on
the first node the profile lists, or on the hub when there is no node. They
never run on the Mac. While that node is stopped, they do not run; take it out
with `fleet devbox remove <host>` and they move to the next node. Each needs
answers:

| Setting | What to ask | Used by |
| --- | --- | --- |
| `orchestration.loopProject` | The folder of a repo they already opened in T3 Code on that machine, where the loops and the digest start threads. | All three |
| `orchestration.qualityArea` | The paths in that repo the loops may change, such as `src/api`. | The two loops |
| `orchestration.ledgerRepo` | A private repo for the loops' ledger. It records production numbers, so it stays private. | The two loops |

On a first setup, recommend them off: they run at night without a person,
and they need a node and a repo the person works in. A preset can turn them
on, such as `everything`. Setup on the Mac does not ask their answers, but the
node refuses the profile without them. So with such a preset, add
`--workflows quality-loop=off,signal-loop=off,pr-digest=off` to the setup
command, or, when they want the loops now, add the three answers as `--set`
lines. Once a node runs, turn one on with its answers:

```sh
fleet packs --workflows quality-loop=on --set orchestration.loopProject=<folder> --set orchestration.qualityArea=<paths> --set orchestration.ledgerRepo=<owner/name>
```

## Question guard

The `question-guard` workflow is on by default. It installs one hook file,
`hooks/ask-guard.ts`, for two events in Claude and Codex:

- **Stop.** A top-level T3 thread that ends its turn with a decision in prose
  is stopped once and told to ask with the question tool.
- **PreToolUse on `t3_thread_send`.** An agent sends to a thread on this
  machine whose running turn waits on a question card. When the send's mode is
  `auto`, `steer` or `restart`, or has no mode, it interrupts that turn, and T3
  cancels the card. The hook denies such a send and tells the agent to send
  again with `mode: "queue"`. The queued message reaches the thread after the
  person answers. A send in mode `queue`, or to an idle thread, passes. T3
  queues a send with `freshContext: true` in mode `steer` or `restart`, so it
  passes too. With `freshContext: true` in mode `auto`, T3 still steers, so it
  is denied. The hook reads the card from `pendingRuntimeRequest` in T3's shell
  snapshot. A card without an id counts as one card for each running turn.

The send guard never traps an agent:

- It denies a send once for each session, card, thread and message. Only the
  same message to the same thread again passes, for an agent whose message
  replaces what the card asks. A different message is denied again. It keeps
  these records in `~/.local/state/fleet/ask-guard/`, and removes records
  older than one day when it writes a new one.
- It lets the send pass on any error: when T3 cannot be read, when a T3 call
  does not answer within 3 seconds, when it cannot write its record, and when
  the send names another machine's `environmentId`. The hook makes three T3
  calls: it opens a session, reads the shell snapshot, and closes the session.
  So a send waits at most about 9 seconds.
- While `~/.config/fleet/ask-guard.off` exists, every send passes. The Stop
  check stays on.
