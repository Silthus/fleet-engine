# Setup note: Context library

Read this when the person picks the Context library pack.

The library is one private GitHub repo of Markdown notes, and every machine
keeps a checkout of it. Ask with your question tool:

- **Their context repo**: when they have one, add
  `--set context.repo=<owner/name>`. The checkout is then `context.path`,
  `~/dev/context` unless they set it.
- **A repo they already have**: add `--set context-library.repo=<owner/name>`.
  When the checkout should live somewhere other than `~/dev/context-library`,
  also add `--set context-library.path=<folder>`.
- **New repo**: create a private repo first, such as
  `gh repo create <their login>/context-library --private --add-readme`, then
  add `--set context-library.repo=<their login>/context-library`.

With the MCP gateway on, the hub also serves the library's search as the
`context_search` tool. It mounts the hub's checkout read-only and logs no
search. Until the hub's first sync clones the library, the gateway runs
without the tool, and its upstream check says what it waits for.

With the Slack pack's trigger on, their own `:brain:` reaction on a Slack
message saves its thread as a note. The reaction shows `:eyes:` while it runs
and goes away once the note is saved. After that, the note updates by itself
when the thread gets new replies and then stays quiet for 30 minutes. A
thread with no reply for a month stops updating; a second `:brain:` updates the
note at once and follows the thread again.
