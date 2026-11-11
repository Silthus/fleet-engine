# Fleet

<img src="docs/fleet.svg" alt="Your Mac runs T3 Code and links to your devboxes, where agent threads work in their own worktrees. An optional hub shares MCP servers. Every machine reads your private profile repo." width="760">

Coding agents get much better with good rules, skills, and a machine that
stays on. Setting that up by hand takes a day per machine, and the machines
drift apart.

**Fleet** sets up T3 Code, Claude Code, Codex, and a set of agent workflows on
your Mac and your Linux devboxes. You pick the workflows as **packs**. Your
answers live in your own private **profile** repo, so every machine gets the
same setup.

## Getting started

1. **Download [T3 Code](https://t3.codes)** and open it. Its Welcome page sets
   up one agent, Claude Code or Codex, and signs you in.
2. **Sign in with T3 Connect.** In T3 Code, open **Settings → Sharing &
   access**, sign in, and turn on **T3 Connect**. It links your Mac to your
   devboxes and your phone.
3. **Paste this prompt** into a new thread in T3 Code on your Mac, or
   [open it in T3 Code](https://app.t3.codes/new?prompt=Set%20up%20Fleet%20on%20this%20Mac%20with%20me.%20Read%20https%3A%2F%2Fraw.githubusercontent.com%2FSilthus%2Ffleet-engine%2Fmain%2FSETUP.md%20and%20follow%20it%20step%20by%20step.):

   ```text
   Set up Fleet on this Mac with me. Read https://raw.githubusercontent.com/Silthus/fleet-engine/main/SETUP.md and follow it step by step.
   ```

From here the agent guides you. It explains each part and runs the install.
You answer setup's questions and do your own sign-ins.

## See what it does

Read [A day with Fleet](https://silthus.github.io/fleet-engine/) to see what
each pack does for you during a workday. The page is `page/index.html`,
generated from the pack data by `bun scripts/build-page.ts`.

## Status

Version 0.1.0 is the first public release. It is early. On every pull
request, CI runs the install as a new Linux user, then `fleet setup` and
`fleet doctor`, with a sandbox GitHub account. Other paths are built but not
yet proved end to end, such as a run on a clean Mac user and the real
sign-ins. The [changelog](CHANGELOG.md) lists them under "Known gaps".

## Set it up by hand

Run this as your login user, not with `sudo`, on macOS or on Linux (x64 or
arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh | sh
```

Read [`get.sh`](get.sh) first if you want to know what runs. It:

- installs what Fleet needs if it is missing: the GitHub CLI, Bun, and T3
  Code. On a Mac it first installs the Command Line Tools and Homebrew if
  needed. On Linux, install `curl`, `git`, `tar`, `sha256sum`, `python3`, and
  cron first. Linux also needs systemd's user manager, so T3 Code can run as a
  service. To keep it running after you log out, an administrator runs
  `sudo loginctl enable-linger <your user>` once.
- fetches the engine into `~/.local/share/fleet/engine` and puts `fleet` in
  `~/.local/bin`.
- adds one line to your shell's login file, so `~/.local/bin` and
  `~/.bun/bin` are on your `PATH`.
- starts `fleet setup`.

`fleet setup` asks plain-language questions. It asks you to sign in to
GitHub, and to Claude, ChatGPT, or both, depending on the plan you pick. It
then creates the private repo `fleet-profile` in your GitHub account, pushes
your answers there, and applies your packs to this machine. Running `get.sh`
again picks up where it stopped.

[Getting started](docs/getting-started.md) walks through it step by step, from
a new Mac to a linked Coder devbox, with what each sign-in asks.

## Develop

```sh
bun install
bun run test
bun run typecheck
```

See [GLOSSARY.md](GLOSSARY.md) for the words Fleet uses.

## License

MIT. See [LICENSE](LICENSE).
