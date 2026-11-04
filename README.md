# Fleet engine

Fleet sets up T3 Code, Claude Code, Codex, and a set of agent workflows on a
Mac and on Linux devboxes. You pick the workflows as **packs**. Your answers
live in your own private **profile** repo, so every machine you own gets the
same setup.

This repository is the **engine**: the `fleet` command, the bootstrap script,
and the public packs. It is a work in progress and not ready to use yet.

## Develop

```sh
bun install
bun run test
bun run typecheck
```

See [GLOSSARY.md](GLOSSARY.md) for the words Fleet uses.

## License

MIT. See [LICENSE](LICENSE).
