# Memory

Shared memory is `~/.agents/memory`, a clone of the private repo in `memory.repo` on every machine with the Memory pack. Every five minutes, each machine commits and pushes its memory changes and pulls the others'. Claude Code uses the directory as its auto memory and loads `MEMORY.md` by itself.

## Recall

- Read `~/.agents/memory/MEMORY.md` at the start of a task when your harness has not loaded it.
- Search before you research a fact about me, my machines, my tools, or a repo: `grep -ril <term> ~/.agents/memory`.
- A memory is true as of when it was written. Check a file, flag, or command it names before you act on it, and fix the memory when it is wrong.

## Save

Save what a future agent could not find by looking: a correction or a preference from me, a trap that cost real time, a decision and its reason, or where outside information lives. Leave out what the code, the Git history, or `AGENTS.md` already says.

Memory holds what recurs. A preference or decision for one pull request, ticket, or task stays in that work, unless I state it as a rule for how I work everywhere. A choice you made is never a rule.

- Write one memory per file. Put a memory about one technology in `tech/<technology>/`, a memory about one repo in `projects/<repo>/`, and a general one at the top.
- Start each file with frontmatter, then the fact:

  ```markdown
  ---
  name: <short-kebab-case-slug>
  description: <one line, used to decide relevance>
  metadata:
    type: user | feedback | project | reference
  ---
  ```

- Add one line to `MEMORY.md` under the heading of its scope: `- [Title](path) — hook`. Keep `MEMORY.md` at 180 lines or fewer: Claude Code loads only its first 200 lines. Fleet blocks a write that makes it longer.
- Update the memory that covers a fact before you add another. Delete a memory that turned out wrong.
- Name where a secret lives, never its value. The sync refuses to push a secret.
- Leave the files uncommitted: the sync commits and pushes them.
