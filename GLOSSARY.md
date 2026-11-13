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
A question a thread asks the person with the question tool: `AskUserQuestion` in Claude, `request_user_input` in Codex. T3 shows it as a card, and the thread's turn waits until the person answers. A message sent to the thread in a mode other than `queue` cancels the card.
_Avoid_: Prompt, popup, dialog
