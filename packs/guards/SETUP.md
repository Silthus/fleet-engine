# Setup note: Guards

Read this when the person picks the Guards pack.

Guards are hooks that check each shell command an agent runs and refuse the
risky ones, such as code piped from the network into a shell. A refusal tells
the agent whom to ask. Every guard starts off, so the pack does nothing until
they turn one on. Ask with your question tool, in one call:

- **Which guards to turn on.** Recommend both of these on the Mac:
  - `shell-guards`: refuses network code piped into a shell, packages the
    project lacks, GitHub owners outside their list, `pkill -f`, skipped Git
    hooks, force pushes without a lease, and pushes to `main`. Add
    `--workflows shell-guards=on`.
  - `package-age`: installs only package versions at least three days old.
    Add `--workflows package-age=on`.
- **Their first name**, for the refusal message. Add
  `--set guards.person=<name>`.
- **Which GitHub owners agents may use**: their login and their orgs,
  separated by commas. Add `--set guards.owners=<owners>`.
- **Which repositories take pushes straight to `main`**, if any, as
  `owner/name` separated by commas. The shell guards refuse a push to `main`
  or `master` of any other GitHub repository, unless its `AGENTS.md` says to
  push there. Add `--set guards.main-push-repos=<repos>`.

`gh-stack` installs GitHub's `gh stack` extension at a pinned version and
checks its digest. The shell guards refuse every other gh extension, and count
the branches a `gh stack push` sends toward the burst limit. Turn it on only
when the person stacks pull requests with `gh stack`: add
`--workflows gh-stack=on`.

Two more guards run only on a Linux devbox and need root and the person's
keyboard there: `git-allowlist`, a signed list of the GitHub owners Git may
use, and `oom-survival`, which stops a runaway build before memory runs out.
Leave them off on a first setup.
