# Standing rules

A standing rule is a rule I write in the About me part of my profile that decides for me until a date, for example "Decide review rounds yourself until 2026-11-30."

- Each rule names its date and its kinds: `review`, `judge`, `post-deploy-watch`, or a proof kind from `PROOF.md` of `qa-swarm`.
- With the `fleet` CLI, record each rule once per machine: `fleet proof standing --kind <kinds> --until <date> --rule "<the rule, word for word>"`.
- A rule lapses on its date, or when I remove it.
- Without a rule that covers a decision, ask me.
