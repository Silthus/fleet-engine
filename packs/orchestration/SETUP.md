# Setup note: Orchestration

Read this when the person picks the Orchestration pack.

**Maps** and **side threads** work with defaults. A map is one issue that
lists tickets; a conductor thread starts one worker thread per ticket. Maps
live in the issues of their profile repo unless they name another
repo with `--set orchestration.tracker=<owner/name>`.

Three workflows run by themselves on a schedule and start off:
`quality-loop`, `signal-loop`, and `pr-digest`. Each runs on one machine only, on
the first node the profile lists, or on the hub when there is no node.
While that node is stopped, they do not run; take it out
with `hedge devbox remove <host>` and they move to the next node. Each needs
answers:

| Setting | What to ask | Used by |
| --- | --- | --- |
| `orchestration.loopProject` | The folder of a repo they already opened in T3 Code on that machine, where the loops and the digest start threads. | All three |
| `orchestration.qualityArea` | The paths in that repo the loops may change, such as `src/api`. | The two loops |
| `orchestration.ledgerRepo` | A private repo for the loops' ledger. It records production numbers, so it stays private. | The two loops |

On a first setup, recommend them off: they run at night without a person,
and they need a node and a repo the person works in. A preset can turn them
on, such as `everything`. With such a preset, `hedge setup --chat` on the hub
ends with code `2` and one `--set` line for each answer it needs, and
applies nothing until it has them. So add
`--workflows quality-loop=off,signal-loop=off,pr-digest=off` to the setup
command, or, when they want the loops now, ask the three answers before step
7 and add them as `--set` lines. Once a node runs, turn one on with its answers:

```sh
hedge packs --workflows quality-loop=on --set orchestration.loopProject=<folder> --set orchestration.qualityArea=<paths> --set orchestration.ledgerRepo=<owner/name>
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
  these records in `~/.local/state/hedge/ask-guard/`, and removes records
  older than one day when it writes a new one.
- It lets the send pass on any error: when T3 cannot be read, when a T3 call
  does not answer within 3 seconds, when it cannot write its record, and when
  the send names another machine's `environmentId`. The hook makes three T3
  calls: it opens a session, reads the shell snapshot, and closes the session.
  So a send waits at most about 9 seconds.
- While `~/.config/hedge/ask-guard.off` exists, every send passes. The prose
  Stop check stays on.

### Threads that ask in prose

Some threads get messages that a job queues into them, such as one alert
thread for each incident. A pending question card holds those messages until
the person answers it. The setting `orchestration.proseTitles` names the
title starts of such threads, separated by commas, such as `⚠️, 🚨`. It is
empty by default. A thread whose title starts with one of them:

- ends its turn with a decision in prose, and the Stop check lets it pass;
- gets each `AskUserQuestion` or `request_user_input` call denied, with the
  reason to write the questions in its last message.

The match ignores the emoji variation selector, so `⚠️` also matches `⚠`. The
card check lets a card pass on any error, and while
`~/.config/hedge/ask-guard.off` exists.

### Proof check at Stop

A T3 thread that owns an open PR is stopped once when it ends its turn while
`hedge proof gate` has not passed at the PR's pushed head. The reason names the
one step still owed, with the command for that PR:

- push the local commits on the PR's branch, then run the gate;
- commit and push changed tracked files, or restore them, on the PR's branch
  or on a detached HEAD at the PR's pushed head;
- push the commits of a detached HEAD in the PR's worktree, when HEAD
  continues the PR's pushed head. On a stack, that is the nearest layer that
  HEAD continues;
- run the gate at the pushed head, when no run is recorded there;
- fix what the last gate run failed on, or, for exit 3, decide each gap by
  tier with `hedge decision record`, or ask the person, or, for exit 75, wait
  for CI with `hedge proof gate --wait 10`.

It checks each open PR the thread owns whose repository is the `origin` of the
thread's checkout. A subagent thread owns nothing while the thread it belongs
to is open. A fork owns its own PRs and those of its subagents. Each run of
`hedge proof gate` records its exit code and first failure line for the commit
it judges, as its own numbered file under
`~/.local/state/hedge/proof/<owner>/<name>/<pr>/gate-record/<commit>/`, with
the repository name in lower case. The run writes the file when it starts, as
a failure, and replaces it with its result when it ends. The check reads the
newest file, so an older run that ends late never replaces a newer result,
and a run that crashed counts as failed. The check reads that record, T3's shell
snapshot, and local git. It never runs the gate, a test, a model, or a GitHub
call. It trusts `origin/<branch>` as the pushed head.

The stop passes when any of these holds:

- `~/.config/hedge/ask-guard.off` exists. It turns off the send guard and this
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
  a lane runs with `codex exec`. The model sessions that Hedge starts (the
  judge, reviewers, the arbiter, the eval judge, and `hedge context add`) get
  no `T3CODE_THREAD_ID`, so the check never runs in them;
- any read fails, or the check takes longer than 10 seconds. At the deadline
  it stops the git and `ps` commands it started, and the hook process exits
  once it has answered, even when a helper of those commands still runs.

### Closing-line parking

The `parking` workflow is off by default, and needs `question-guard`. When the
prose check, the background check and the proof check let a stop pass, the
same Stop hook parks a top-level T3 thread by the mark its last line starts
with:

| Setting | Default | The thread |
| --- | --- | --- |
| `orchestration.waitMark` | ⏳ | waits on someone else. The hook snoozes it for `orchestration.waitSnoozeDays` days, 3 by default. |
| `orchestration.snoozeMark` | 💤 | snoozes until the time on the line, such as `14th Nov 22:00`, in `orchestration.timeZone`, or this machine's time zone when that is empty. With no future time on the line, within 180 days, the stop is sent back once, to snooze with `t3_thread_organize`. |
| `orchestration.checkMark` | 🔕 | waits on its own scheduled check. It needs an enabled scheduled task bound to it with a next run in T3's state, else the stop is sent back once. A detached process settles the thread once its run completes. |
| `orchestration.doneMark` | ➡️ | is done, and the person may settle it. The hook changes nothing. |

A line that ends on the done or the check mark is sent back once while the
thread owns an open PR that no other open thread links. `hedge pr handover`
records a handover only to an open thread that links the PR, and a handover
counts only while that thread stays open and links it. A link the thread
dismissed from a stack does not count. The hook reads the
PR links from T3's shell snapshot and makes no GitHub call.

The hook leaves the thread alone when it is a child thread, was delegated from
another machine, waits on a question card, is settled or already snoozed, or
when the hook runs in a nested model session. A thread the person pinned
stays in view: only the snooze mark parks it, and the detached settle skips a
thread pinned before its run ends. The settle also skips a run that did not
complete, a run that another run follows, a pending request, a PR watch that
started after the stop, and a run still going after 10 minutes. Right before
it settles, it checks again that parking is still on, the kill switch is off,
the scheduled check is still on, and the thread does not own an open PR alone.
Then it reads the thread once more, checks all of that again, and settles
only if the thread is still not pinned, not snoozed, and has no new PR watch. T3
takes no pin or watch condition on a settle, so a pin set in that last moment
can still be lost.

After the hook sends a stop back once, it does not send it back again. It
still parks the thread when the corrected closing line allows it.

The prose check, the background check and the proof check read the same
marks. Parking starts only while the hook has run for less than 6 seconds, and
gives up after 4 more. Any error lets the stop pass. The hook keeps one T3
session for all its calls.
