# Setup note: Context library

Read this when the person picks the Context library pack.

The library is one private GitHub repo of Markdown notes, and every machine
keeps a checkout of it. Ask with your question tool:

- **A repo they already have**: add `--set context-library.repo=<owner/name>`.
  When the checkout should live somewhere other than `~/dev/context-library`,
  also add `--set context-library.path=<folder>`.
- **New repo**: create a private repo first, such as
  `gh repo create <their login>/context-library --private --add-readme`, then
  add `--set context-library.repo=<their login>/context-library`.

With the MCP gateway on, the hub also serves the library's search as the
`context_search` tool. It mounts the hub's checkout read-only and logs only
the time and the number of results of each search, never the words or the
results. Until the hub's first sync clones the library, the gateway runs
without the tool, and its upstream check says what it waits for.

With the Slack pack's trigger on, their own `:brain:` reaction on a Slack
message saves its thread as a note. The reaction shows `:eyes:` while it runs
and goes away once the note is saved. A second `:brain:` updates the note.
