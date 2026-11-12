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
