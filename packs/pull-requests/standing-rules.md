# Standing rules and decisions

## Decision ledger

With the `fleet` CLI, every decision about a pull request's proof and process goes to the decision ledger: `fleet decision record`. Run `fleet decision list --pr <owner/repo#n>` before you ask me.

- For a proof gap, record it with `fleet proof gap --kind <kind> --reason <why>` first: it prints the question to ask. A judge gap counts only answers I give after it is recorded.
- Ask me with your question tool, and name each pull request and each gap kind in the question. After I answer, record it with `fleet decision record --mark 👤 --class <class> --pr <owner/repo#n>`, or `--mark 👍` when I chose your recommended option. One answer records one decision, and it covers each pull request its question names.
- To accept a proof gap, my choice starts with "Accept", or it is "Yes" to a question that starts with "Accept the <kind> gap?". When I keep a gap owed, record it with `--keep-owed`. It outranks any decision of yours, and you cannot void it: only my acceptance lifts it.
- Decide alone with `--mark 🤖` and your question, answer, rejected option, and reason, only where the `Tier:` line of the merge-risk callout at HEAD lets you: never on an ungraded pull request, and on a critical one only process (review rounds, status asks, judge and post-deploy-watch gaps). A panel gap is always mine to accept.
- `fleet proof gate` prints each 🤖 decision that lapsed on a kind that is still open, and why. Ask me then, or decide again once the reason is gone.
- `fleet decision void <id> --reason <why>` ends a decision whose condition no longer holds. It refuses my keep-owed.
- When I reverse a decision, record my words with `fleet decision reverse <id> --words '<date> "<my words>"' --thread <id>`: only my words in the T3 app count, never a GitHub comment. Quote the date I wrote them; when I wrote the same words twice that day, add `--message <id>`. Only my words after the decision reverse it, and one answer reverses one decision. Then decide or ask again. It refuses my keep-owed and a voided decision.
- Two reversals of your decisions in one class within 28 days brake the class: decide nothing alone in it. Ask me with your question tool, in a question that starts with "Lift the brake on <class>", such as "Lift the brake on design decisions?". When I answer "Lift" or "Yes", record it with `fleet decision lift --class <class> --words '<date> "<my answer>"' --thread <id>`. A "Yes" to a question worded any other way lifts nothing. One answer lifts one brake or records one decision, never both.
- When you start a side fix alone, record it as a `scope` decision with `--link <the side fix's thread>`.
- When the lane ends, record your last decisions, then run `fleet proof gate` on each pull request (`--landed` on a merged one), run `fleet proof receipt` on each pull request after its gate, and send the output of `fleet decision report --pr <owner/repo#n>...` as your final message. Post it once on the lane's ticket or its bottom pull request. The report prints only what the gate saved; a decision recorded after the gate sends you back to the gate.

## Standing rules

A standing rule is a rule I write in the About me part of my profile that decides for me until a date, for example "Accept prod-shape gaps on docs-only pull requests until 2026-11-30."

- Each rule names its date and its proof kinds from `PROOF.md` of `qa-swarm`. Review rounds, judge gaps, and post-deploy-watch gaps take no standing rule: decide them in the decision ledger.
- With the `fleet` CLI, record each rule once per machine: `fleet proof standing --kind <kinds> --until <date> --rule "<the rule, word for word>"`.
- A rule lapses on its date, or when I remove it. A gap I keep owed takes no standing rule.
- Without a rule or a decision that covers it, ask me.
