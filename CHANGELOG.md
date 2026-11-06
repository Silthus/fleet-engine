# Changelog

## v0.1.0

The first public release. Fleet sets up T3 Code, Claude Code, Codex, and a set
of agent workflows on a Mac and on Linux devboxes. You pick the workflows as
packs, and your answers live in your own private profile repo.

### The command

- `get.sh` installs what Fleet needs, fetches the engine at a pinned ref, puts
  `fleet` on the login PATH, and starts `fleet setup`. Running it again skips
  the steps that are done.
- `fleet setup` asks only the questions that have no default, in plain words.
  `--preset` and `--non-interactive` run it with no questions.
- `fleet apply` puts your profile's packs onto the machine. `fleet doctor`
  checks the machine against the same plan without changing it. `fleet update`
  moves the engine and your profile forward, then applies.
- `fleet packs`, `fleet settings`, and `fleet set` turn packs and workflows on
  and off and change their settings. `fleet devbox add` makes an SSH host one
  of your devboxes.

### Packs

- **Base** (always on): safety rules, the model table, T3 Code defaults written
  before its first start, linked machines, worktree cleanup, a disk guard, and
  nightly updates.
- **Pull requests** (on): every fix or feature ends as a proven, reviewed draft
  pull request. Ship words take it to merged.
- **Orchestration** (on): big work becomes a map of tickets that a conductor
  thread works through, and side work gets its own thread. The quality loop,
  the signal loop, and the PR digest are opt-in.
- **Communication** (on): agents write in your voice, give short updates, and
  share plans and previews as links.
- **Memory** (off): agents on all your machines share what they learn through
  your own private memory repo.
- **Hub** (off): one always-on devbox manages the others. It signs in to your
  MCP servers once, keeps your devboxes linked, and watches their disks. The
  nightly Dream task and own-account balancing are opt-in. Own-account
  balancing routes Claude Code across several of your own subscriptions. It is
  off by default, and the page shows the Anthropic terms it touches.
- **Slack** (off): your own message, reaction, or mention in Slack starts a T3
  thread about it.

Team packs plug in as pack sources. The presets are Starter, Everyday, and
Michael's.

### The page

[A day with Fleet](https://silthus.github.io/fleet-engine/) shows what each
pack does during a workday and builds the one command that sets up the packs
you pick.

### Known gaps

No agent can run these steps, so they are not yet proved: a run on a clean Mac
user, real GitHub, Claude, and ChatGPT sign-ins, `t3 up --connect`, and a live
Coder devbox.
