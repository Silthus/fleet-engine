# Setup note: Guards

Read this when the person picks the Guards pack.

Guards are hooks that check each shell command an agent runs and refuse the
risky ones, such as code piped from the network into a shell. A refusal tells
the agent whom to ask. Ask with your question tool, in one call:

- **Their first name**, for the refusal message. Add
  `--set guards.person=<name>`.
- **Which GitHub owners agents may use**: their login and their orgs,
  separated by commas. Add `--set guards.owners=<owners>`. With no list,
  guards do not check owners.

On the Mac, nothing else is needed. On a Linux devbox, two steps run as root
and need the person's keyboard: the signed Git allowlist and earlyoom.
