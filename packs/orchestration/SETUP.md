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
  is stopped once and told to ask with the question tool. When that check lets
  the stop pass, the proof check below runs.
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
- While `~/.config/fleet/ask-guard.off` exists, every send passes. The prose
  Stop check stays on.

### Proof check at Stop

A T3 thread that owns an open PR is stopped once when it ends its turn while
`fleet proof gate` has not passed at the PR's pushed head. The reason names the
one step still owed, with the command for that PR:

- push the local commits on the PR's branch, then run the gate;
- commit and push changed tracked files, or restore them, on the PR's branch
  or on a detached HEAD that the PR's pushed head contains;
- push the commits of a detached HEAD in the PR's worktree, when HEAD
  continues the PR's pushed head;
- run the gate at the pushed head, when no run is recorded there;
- fix what the last gate run failed on, or, for exit 3, decide each gap by
  tier with `fleet decision record`, or ask the person.

It checks each open PR the thread owns whose repository is the `origin` of the
thread's checkout. A subagent thread owns nothing while the thread it belongs
to is open. A fork owns its own PRs and those of its subagents. Each run of
`fleet proof gate` records its exit code and first failure line for the commit
it judges, as its own numbered file under
`~/.local/state/fleet/proof/<owner>/<name>/<pr>/gate-record/<commit>/`, with
the repository name in lower case. The run writes the file when it starts, as
a failure, and replaces it with its result when it ends. The check reads the
newest file, so an older run that ends late never replaces a newer result,
and a run that crashed counts as failed. The check reads that record, T3's shell
snapshot, and local git. It never runs the gate, a test, a model, or a GitHub
call. It trusts `origin/<branch>` as the pushed head.

The stop passes when any of these holds:

- `~/.config/fleet/ask-guard.off` exists. It turns off the send guard and this
  check;
- a stop hook already continued this turn (`stop_hook_active`), so the check
  blocks at most once per turn;
- the thread waits on a question card, or its last line starts with
  `NEEDS_HUMAN:`;
- the thread waits on a child task, a thread wait, or a command or monitor
  it awaits; on Claude, on a subagent, a monitor, or a scheduled wake-up. A
  command or monitor the thread does not await, such as a dev server or a PR
  watch whose CI has settled, is no wait, as in T3;
- a subagent thread of the thread, such as a delegated task, still runs,
  waits on a question, or awaits work of its own. A fork of the thread is no
  wait;
- a PR watch has not seen CI settle at the pushed head. T3's `checksPending`
  answers this when the watch has it; otherwise no check has passed or
  failed yet;
- the thread was delegated from another machine;
- the hook runs in a model session that another one started, such as a review
  a lane runs with `codex exec`. The model sessions that Fleet starts (the
  judge, reviewers, the arbiter, the eval judge, and `fleet context add`) get
  no `T3CODE_THREAD_ID`, so the check never runs in them;
- any read fails, or the check takes longer than 10 seconds. At the deadline
  it stops the git and `ps` commands it started, and the hook process exits
  once it has answered, even when a helper of those commands still runs.
