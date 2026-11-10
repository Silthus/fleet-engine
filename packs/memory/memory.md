# Memory

Shared memory is `~/.agents/memory`, a clone of the private repo in `memory.repo` on every machine with the Memory pack. Every five minutes, each machine commits and pushes its memory changes and pulls the others'. Claude Code uses the directory as its auto memory and loads `MEMORY.md` by itself.

## Recall

- A session starts with the main index, `MEMORY.md`, and the index of the repo it works in, `projects/<repo>/INDEX.md`. Fleet adds them when the session starts. The repo is the last part of the checkout's `origin` URL, such as `notes-app` for `you/notes-app`. Read an index yourself when your harness did not load it.
- Search before you research a fact about me, my machines, my tools, or a repo: `grep -ril --exclude-dir=.git <term> ~/.agents/memory`.
- A memory is true as of when it was written. Check a file, flag, or command it names before you act on it, and fix the memory when it is wrong.

## Save

Save what a future agent could not find by looking: a correction or a preference from me, a trap that cost time, a decision and its reason, or where outside information lives. Leave out what the code, the Git history, or `AGENTS.md` already says.

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

  The types: `user` is a fact about me; `feedback` is a correction or preference from me, with its reason; `project` is a fact about ongoing work that the code does not show; `reference` is where outside information lives. The type `project` is not the same as the `projects/` folder: any type can live in any folder.

- Add one line for it to the index of its folder. A repo memory goes in `projects/<repo>/INDEX.md`, with a path relative to that folder. Any other memory goes in `MEMORY.md` under the heading for its folder: `## General` or `## tech/<technology>`. Add the heading or the repo index when it is missing, and give `MEMORY.md` one line for each repo index under `## Repositories`. A line reads `- [Title](path) — hook`.
- Keep `MEMORY.md` at 180 lines or fewer: Claude Code loads only its first 200 lines. In Claude Code, Fleet refuses a `Write` or `Edit` that makes it longer. Other writes and the sync merge are not checked, so count the lines after you add one.
- Update the memory that covers a fact before you add another. Delete a memory that turned out wrong.
- Name where a secret lives, never its value. The sync stops when an unpushed change holds a secret: it takes the commits back, leaves the files as they are, and pushes nothing until you remove the secret.
- Leave the files uncommitted: the sync commits and pushes them.

## Sync

- When two machines change the same lines of a file, the machine that syncs last wins. The other version stays in the history.
- After a merge, `MEMORY.md` can hold both versions of a line. Keep one.
- A file with conflict markers stops the sync until you fix it.
- The sync uses the `main` branch of the memory repo. An empty repo is fine; the first sync starts `main`.
