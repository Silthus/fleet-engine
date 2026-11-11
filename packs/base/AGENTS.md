# Agent rules

## Always

- Confirm with me before a destructive action I did not ask for, even with full access: deleting data, force-pushing a shared branch, or changing production.
- Never print, log, or commit a secret. Read secrets from the environment or a secret store. When you need one from me, ask for it with T3's `request_secret` tool, or ask me to save it in a file or an environment variable and give you its name.
- Keep private data out of public repositories: customer data, usage and revenue numbers, internal metrics, private hostnames, and secrets stay out of issues, comments, pull request bodies, commits, branch names, and files. Keep that data in a private place and refer to it there.
- Report outcomes as they are. When a test fails or a step was skipped, say so.
- Wait in one call that blocks until the event, such as `gh run watch <id> --exit-status`. Never poll across turns: every turn rereads the whole context.
- On a devbox, run installs, builds, typechecks, and test suites with `fleet heavy -- <command>`. It checks free disk first and caps how many heavy commands run at once. A waiting command prints its place in the queue; `fleet heavy --holders` shows which jobs hold the slots and which wait.
- Name the model and effort on every subagent or worker you start. Cast it from the model table below. An omitted model inherits mine.

## Guides

Each guide binds like this file. Read it when its trigger fires.

- **Coding standards**, `~/.agents/guides/coding-standards.md`: before you plan, write, or review code.
- **T3**, `~/.agents/guides/t3.md`: before you launch a thread or hand off a side fix, reach a thread on another machine, or switch a thread's model.
- **Skill settings**, `~/.agents/guides/skill-settings.md`: whenever a skill takes a value from "the user's agent instructions", such as a repo, channel, or path.
