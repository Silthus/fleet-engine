# Setup note: Memory

Read this when the person picks the Memory pack.

Agents keep what they learn as notes in one private GitHub repo, and every
machine reads and writes it. Ask with your question tool:

- **New repo** (the default): the private repo
  `<their GitHub login>/fleet-memory`. On the first setup, setup creates it.
  Add nothing to the command. On a Fleet that already runs, `fleet packs`
  creates no repo. First run
  `gh repo create <their GitHub login>/fleet-memory --private`, then add
  `--set memory.repo=<their GitHub login>/fleet-memory`.
- **A repo they already have**: add `--set memory.repo=<owner/name>`. When the
  notes live in one folder of that repo, also add
  `--set memory.subtree=<folder>`.
