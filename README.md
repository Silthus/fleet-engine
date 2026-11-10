# Fleet engine

Fleet sets up T3 Code, Claude Code, Codex, and a set of agent workflows on a
Mac and on Linux devboxes. You pick the workflows as **packs**. Your answers
live in your own private **profile** repo, so every machine you own gets the
same setup.

This repository is the **engine**: the `fleet` command, the bootstrap script,
and the public packs.

## Status

Version 0.1.0 is the first public release. It is early. On every pull
request, CI runs the install below as a new Linux user, then `fleet setup` and
`fleet doctor`, with a sandbox GitHub account. Other paths are built but not
yet proved end to end, such as a run on a clean Mac user and the real
sign-ins. The [changelog](CHANGELOG.md) lists them under "Known gaps".

## See what it does

Read [A day with Fleet](https://silthus.github.io/fleet-engine/) to see what
each pack does for you during a workday, pick yours, and copy the one command
that sets them up. The page is `page/index.html`, generated from the pack data
by `bun scripts/build-page.ts`.

## Install

Run this as your login user, not with `sudo`, on macOS or on Linux (x64 or
arm64):

```sh
curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh | sh
```

Read [`get.sh`](get.sh) first if you want to know what runs. It:

- installs what Fleet needs if it is missing: the GitHub CLI, Bun, and T3
  Code. On a Mac it first installs the Command Line Tools and Homebrew if
  needed. On Linux, install `curl`, `git`, `tar`, `sha256sum`, and `python3`
  first.
- fetches the engine into `~/.local/share/fleet/engine` and puts `fleet` in
  `~/.local/bin`.
- adds one line to your shell's login file, so `~/.local/bin` and
  `~/.bun/bin` are on your `PATH`.
- starts `fleet setup`.

`fleet setup` asks plain-language questions. It asks you to sign in to
GitHub, and to Claude, ChatGPT, or both, depending on the plan you pick. It
then creates the private repo `fleet-profile`
in your GitHub account, pushes your answers there, and applies your packs to
this machine. Running `get.sh` again picks up where it stopped.

## Develop

```sh
bun install
bun run test
bun run typecheck
```

See [GLOSSARY.md](GLOSSARY.md) for the words Fleet uses.

## License

MIT. See [LICENSE](LICENSE).
