# Fleet glossary

The words the engine, its packs, and its docs use.

## Setup layers

**Engine**:
The public Fleet installer and CLI that puts packs and a profile onto a machine.
_Avoid_: Core, framework, starter

**Pack**:
An opt-in bundle of instruction fragments, guides, skills, skill settings, provider config, jobs, and steps that adds one way of working. It is a `pack.json` plus files.
_Avoid_: Module, plugin, add-on, extension, group

**Base pack**:
The one pack every user gets.
_Avoid_: Core, default pack

**Pack source**:
A Git repo that holds packs, fetched at a pinned ref. The engine repo is one, and a profile can list more, such as a private team repo.
_Avoid_: Registry, marketplace, tap

**Profile**:
One person's private repo of answers and files: `fleet.json`, an optional `about-me.md`, and `overrides/`. It is also their dotfiles repo.
_Avoid_: Personal layer, config, dotfiles

**Context repo**:
One person's repo of what their agents learn and record: memory, dreams, notes, to-dos, ideas, research, maps, and logs such as the lessons log and the rollout log. It is meant to be shared with their team, so it may live in the team's GitHub org, but it is never public. The profile holds private answers and is read by Fleet; the context repo holds shared knowledge and is read and written by agents. `context.repo` names it, and the memory, library, map, and log settings take it as their default.
_Avoid_: Personal repo, notes repo, knowledge base

**Workflow**:
One way of working a pack offers, described in one plain sentence. It is on when its pack is on, the profile does not turn it off, and everything it needs holds.
_Avoid_: Feature, capability

**Preset**:
A named choice of packs and workflows, such as Starter or Everyday, that setup and the page offer.
_Avoid_: Template, bundle

**Model table**:
The model and effort agents use for each kind of work, one table for each AI plan. The Base pack declares it, and a profile can replace any row.
_Avoid_: Model policy, casting

## Applying

**Plan**:
Everything one machine should have, computed from the profile, the machine file, and the fetched pack sources.
_Avoid_: Manifest, desired state

**Reconciler**:
The module that resolves a plan, applies it, and checks it.
_Avoid_: Installer, sync

**Machine file**:
`~/.config/fleet/machine.json`: this machine's role, whether it is a Coder workspace, its profile directory, and setup progress. It never enters the profile.
_Avoid_: Local config, state file

## Machines

**Devbox**:
A Linux machine, local or in the cloud, where agents and T3 threads run. A Coder workspace is a devbox from its first `fleet apply`, and signs Git commits with its Coder key.
_Avoid_: Coding box, agent box

**Node**:
A devbox that stays on, where T3 threads do the work. The hub links the nodes and watches their disks.
_Avoid_: Worker box

**Hub**:
The one machine that the profile's `hub` names, with `fleet hub here`. It runs the items placed on the hub and manages the other machines.
_Avoid_: Controller, master box

## Threads

**Question card**:
A question a thread asks the person with the question tool: `AskUserQuestion` in Claude, `request_user_input` in Codex. T3 shows it as a card, and the thread's turn waits until the person answers. A message sent to the thread in a mode other than `queue` cancels the card. T3 queues a message with `freshContext: true` in mode `steer` or `restart`, so that message does not cancel it.
_Avoid_: Prompt, popup, dialog

## Decisions

**Decision ledger**:
The append-only log of every decision about a pull request's proof and process, at `~/.local/state/fleet/decisions.jsonl` on the hub. Other machines read and append it over SSH. `fleet decision` records, lists, and voids its decisions, and `fleet proof gate` reads it.
_Avoid_: Claim file, answer log

**Ask class**:
The kind of question a decision answers, such as a review round, a proof gap, or a status ask. Each decision names one.
_Avoid_: Decision type, category

**Tier**:
The `Tier:` line of a pull request's merge-risk callout at HEAD: critical or non-critical. A pull request without it is ungraded. The tier limits what an agent may decide alone.
_Avoid_: Risk level, grade

**Acceptance**:
A decision that lets the gate pass over a proof gap. The user's acceptance always counts; an agent's acceptance counts only while nothing lapses it.
_Avoid_: Waiver, override

**Lapse**:
The gate no longer counts an agent's acceptance, because the tier changed, CI ran on HEAD, the user keeps the gap owed, or the gap is a panel gap. The gate prints each lapsed decision of a kind that stays open.
_Avoid_: Expiry, revoke

**Reversal**:
The user's own words in a T3 thread, a message they typed in the T3 app or their answer to a question tool, that replace a decision's answer. A GitHub comment never counts, since agents post on GitHub as the user. A reversed decision prints as 👤 with the replaced answer struck through, and counts no more. A reversal takes the time the user wrote their words, and those words must be newer than the decision. One answer reverses one decision. A gap the user keeps owed and a voided decision take no reversal.
_Avoid_: Undo, override

**Brake**:
Two reversals of the agent's decisions in one ask class within 28 days. The brake holds from the later reversal. While it holds, an agent decides nothing alone in that class. Only the user's answer to a question that names the brake and the class lifts it, and only when it comes after the brake. An answer that starts with "Lift" lifts it. A "Yes" lifts it only when the question starts with "Lift the brake on <class>". One answer lifts one brake or records one decision, never both.
_Avoid_: Lock, freeze

**Proof summary**:
The proof state of a pull request at HEAD that the gate builds: each owed kind, the review, the head, CI, the tier, the judge's verdict, and the lapsed and voided decisions. The gate prints its lines from it, and `fleet proof gate --json` prints it. Each `fleet proof gate` saves its summary for its commit, with the pull request's head, base and base SHA on GitHub, the tier, `--landed`, and a fingerprint of the pull request's proof files, the standing rules and the ledger decisions that cover it. The end-of-run report uses a saved summary for its judge's verdict only while all of these still match.
_Avoid_: Proof status, gate result

**End-of-run report**:
The Markdown that `fleet decision report` prints when a lane ends: what is still the user's, merges under the narrow grant, the lane's decisions, one proofs row per pull request, and the side fixes it started. It never runs the judge. It builds the proof summary again at HEAD, so CI, the standing rules, the decisions and the tier are read as they are now, and it takes the judge's verdict from the summary the gate saved at HEAD. When a decision was recorded after the gate, or the head, base, merge-risk callout or proofs changed, it says the gate has not run at HEAD with these proofs. When the summary it builds does not pass, such as after a check fails, outside the checkout where a review carried across commits cannot be checked, when an accepted gap now rests on a condition the saved judge did not weigh, when CI shows other checks than the ones the judge weighed, or when the head, base or tier moves while the report reads it, it sends the user to the gate and offers no merge. This holds for a merged pull request too, which it sends to `fleet proof gate --landed`. A pull request whose proofs Fleet cannot read is still the user's, with the reason, and the other rows still print.
_Avoid_: Summary, wrap-up
