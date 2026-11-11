# Setup note: Guards

Read this when the person picks the Guards pack.

Guards are hooks that check each shell command an agent runs and refuse the
risky ones, such as code piped from the network into a shell. A refusal tells
the agent whom to ask. Every guard starts off, so the pack does nothing until
they turn one on. Ask with your question tool, in one call:

- **Which guards to turn on.** Recommend both of these on the Mac:
  - `shell-guards`: refuses network code piped into a shell, packages the
    project lacks, and GitHub owners outside their list. Add
    `--workflows shell-guards=on`.
  - `package-age`: installs only package versions at least three days old.
    Add `--workflows package-age=on`.
- **Their first name**, for the refusal message. Add
  `--set guards.person=<name>`.
- **Which GitHub owners agents may use**: their login and their orgs,
  separated by commas. Add `--set guards.owners=<owners>`.

Two more guards run only on a Linux devbox and need root and the person's
keyboard there: `git-allowlist`, a signed list of the GitHub owners Git may
use, and `oom-survival`, which stops a runaway build before memory runs out.
Leave them off on a first setup.
