# Standing rules and decisions

## Decision ledger

With the `fleet` CLI, every decision about a pull request's proof and process goes to the decision ledger: `fleet decision record`. Run `fleet decision list --pr <owner/repo#n>` before you ask me.

- Ask me with your question tool, and name each pull request and each gap kind in the question. After I answer, record it with `fleet decision record --mark 👤 --class <class> --pr <owner/repo#n>`, or `--mark 👍` when I chose your recommended option. One answer records one decision, and it covers each pull request its question names.
- To accept a proof gap, my choice starts with "Accept", or it is "Yes" to a question that starts with "Accept the <kind> gap?". When I keep a gap owed, record it with `--keep-owed`. It outranks any decision of yours, and you cannot void it: only my acceptance lifts it.
- Decide alone with `--mark 🤖` and your question, answer, rejected option, and reason, only where the `Tier:` line of the merge-risk callout at HEAD lets you: never on an ungraded pull request, and on a critical one only process (review rounds, status asks, judge and post-deploy-watch gaps). A panel gap is always mine to accept.
- `fleet proof gate` prints each 🤖 decision that lapsed on a kind that is still open, and why. Ask me then, or decide again once the reason is gone.
- `fleet decision void <id> --reason <why>` ends a decision whose condition no longer holds. It refuses my keep-owed.

## Standing rules

A standing rule is a rule I write in the About me part of my profile that decides for me until a date, for example "Accept prod-shape gaps on docs-only pull requests until 2026-11-30."

- Each rule names its date and its proof kinds from `PROOF.md` of `qa-swarm`. Review rounds, judge gaps, and post-deploy-watch gaps take no standing rule: decide them in the decision ledger.
- With the `fleet` CLI, record each rule once per machine: `fleet proof standing --kind <kinds> --until <date> --rule "<the rule, word for word>"`.
- A rule lapses on its date, or when I remove it. A gap I keep owed takes no standing rule.
- Without a rule or a decision that covers it, ask me.
