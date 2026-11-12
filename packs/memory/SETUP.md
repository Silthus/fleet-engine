# Setup note: Memory

Read this when the person picks the Memory pack.

Agents keep what they learn as notes in one private GitHub repo, and every
machine reads and writes it. Ask with your question tool:

- **New repo** (the default): the private repo
  `<their GitHub login>/fleet-memory`. `fleet setup` and
  `fleet packs --add memory` create it when it is missing. Add nothing to the
  command.
- **A repo they already have**: add `--set memory.repo=<owner/name>`. When the
  notes live in one folder of that repo, also add
  `--set memory.subtree=<folder>`.
