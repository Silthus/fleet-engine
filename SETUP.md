# Set up Fleet with the person

You are an agent in T3 Code on the person's Mac. They pasted the prompt from
the Fleet README or the Fleet page. Set up Fleet with them, from nothing to a
passing `fleet doctor` on this Mac.

## How you work

- **Guide.** Before each step, say in one or two plain sentences what it does
  and why. Size it to what they know (step 2).
- **Ask with your question tool.** Every choice goes through it. Each option
  says what the person gets and what they give up, and one option is marked
  as recommended. Put independent questions in one call. When your question
  tool takes fewer questions in one call, ask the rest in a second call right
  after the first.
- **Secrets go through the secret prompt.** Ask for every secret, such as an
  API key or a token, with the host's secret prompt (in T3 Code, its
  `request_secret` tool), never in chat. Say in one line what the secret is
  for and where to make it. A command that asks for a hidden secret itself,
  such as `fleet slack-trigger setup`, runs in Terminal instead.
- **Say a word before you use it.** The first time you say a Fleet word to the
  person, such as workflow, pack, profile, hub, or node, explain it in one
  plain line.
- **Speak to their choice.** Once they answer step 2, describe only the setup
  they chose. When they chose a hub and nodes, never call the hub optional or
  something for later.
- **Keep it short.** One or two sentences per explanation.
- **Run every command yourself.** The person answers, approves, and does their
  own sign-ins in their browser. Just before a sign-in opens, say what it is
  for.
- **Show, then tell.** Where a step names a visual, show it as a page in the
  chat when you can (T3 Code shows HTML pages that agents publish). Otherwise
  describe it in three lines of text.
- **One PATH.** Your shell started before the install. Begin every command
  that runs `fleet`, `gh`, `bun`, `claude`, `codex`, or `coder` with
  `export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";`.
- **When a step fails.** Explain its last lines and fix what they name. When
  it still fails, or the cause is not clear, offer `fleet triage`. It exists
  after the install makes `~/.local/bin/fleet`. Run
  `fleet triage --print --note "<the failed step and its last line>"` and
  show the person the report. It opens a **public** issue for the Fleet
  maintainer, with private details taken out, so ask before you run the same
  command with `--send`. When `gh` is not signed in, `--send` saves the
  report to a file, says where, and exits 1. That exit is not a new failure.
- **The keyboard in Terminal.** A command that needs the person's keyboard
  runs in a Terminal window: write it to a file in `~/.cache/fleet-setup`
  that ends in `.command`, with a `#!/bin/sh` line and the `PATH` line above,
  make it executable, and `open` it. Ask them to tell you when it ends.

## Picks from the page

The prompt can end with a list that starts with `My picks from the Fleet
page:`. The person chose these on the Fleet page, so do not ask for them
again. When a step uses a line, say the pick back in one sentence and go on.
Ask everything else as the steps say. Without the list, ask every question.

| Line | How to use it |
| --- | --- |
| `Where Fleet runs` | The answer to step 4. |
| `Packs on the first setup` | The packs for step 6, picked one by one. `none` means no pack. Still ask the AI plan, and read each pack's setup note. |
| `Packs once the hub runs` | The answer to item 8 of step 9. `none` means no pack, so skip item 8. |

The page names packs only. Each pack's setup note still asks which of its
workflows to turn on and which settings it needs.

A prompt from an earlier page can carry more lines. Use them too:

- `Workflows on the first setup` and `Workflows once the hub runs`: add the
  list to the command of that step as `--workflows`, without the spaces. Such
  a line wins over a workflow flag from a setup note.
- `Setting`: add `--set <key>=<value>` to the setup command in step 7, once
  for each line.

## While something runs

Steps 1, 5, 7, and 9 start commands that take minutes. While one runs in the
background, explain one of these, in two or three lines, and do not repeat
one. Skip a topic that does not fit their picks:

- **T3 Code's inbox.** A thread that finishes or waits for them shows up in
  the inbox. They answer it there, on the Mac or the phone.
- **The Slack trigger.** With the Slack pack, their own Slack message with
  `:t3code:` starts a thread about it.
- **Threads on nodes.** T3 Code starts a thread on any linked machine. On a
  node, the thread keeps working while the Mac sleeps.
- **What runs each night.** Each machine runs `fleet update` every night, so
  it takes the newest engine and their profile by itself. The last screen of
  setup lists the other jobs under "Runs by itself".

Say whether the step runs once or again later. The install and each sign-in
run once per machine. `fleet update` runs again every night by itself.

## 1. Check the Mac and start the install

Run `uname -s` and `id -u`. Go on when the output is `Darwin` and a user ID
other than `0`. On another system, tell the person that this guide is for a
Mac, and point them at "Set it up by hand" in the README.

Then check for an earlier setup: `~/.local/bin/fleet packs` lists the packs
and their workflows when Fleet already runs here. When it does, show the list
and ask:

- **Change only what they name** (recommended): run `fleet packs` with
  `--add`, `--remove`, and `--workflows` for each change, then go on to step
  8. Everything else stays as it is.
- **Run setup again**: setup reuses their profile repo and starts from its
  packs, workflows, and settings. In the step 7 command, leave out
  `--preset`, and name only what changes with `--add`, `--remove`, and
  `--workflows`. Everything else stays as it is. Files they changed by hand
  are kept, and step 8 shows them.

When `fleet packs` fails or is missing, but
`~/.local/state/fleet/state.json` exists, another Fleet manages files here,
such as one the person set up by hand. Tell them now that setup stops at its
files, and what happens then (see "Another Fleet keeps the files" in step 7).
Ask them to stop what still runs that Fleet, such as a LaunchAgent, so it
does not put its files back. Then start the install as below.

Without an earlier setup, start the install now, so it runs while you ask
and explain. Download the install script and the presets in one command,
and read the script. Keep it in view, because a pipe into `sh` hides what
runs:

```sh
mkdir -p ~/.cache/fleet-setup && curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh -o ~/.cache/fleet-setup/get.sh && curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/presets.json -o ~/.cache/fleet-setup/presets.json && cat ~/.cache/fleet-setup/get.sh
```

Tell the person in two lines what it adds when missing: the GitHub CLI, Bun,
and the `t3` command, the engine in `~/.local/share/fleet/engine`, `fleet` in
`~/.local/bin`, and one `PATH` line in their login file. They asked for this
setup, so start it at once, in the background, and say they can tell you to
stop it. When the script does more than this, tell them what, and ask before
you start it.

You run in T3 Code, so the app is there, and the script needs no Homebrew
and no password. When `xcode-select -p` succeeds, start it in the background
yourself:

```sh
sh ~/.cache/fleet-setup/get.sh --install-only
```

When `xcode-select -p` fails, the Command Line Tools are missing. A Mac
window asks to install them, the person clicks **Install**, and the script
waits for them. Run it in a Terminal window then, and ask them to tell you
when it ends:

```sh
printf '#!/bin/sh\nsh ~/.cache/fleet-setup/get.sh --install-only\n' > ~/.cache/fleet-setup/install.command && chmod +x ~/.cache/fleet-setup/install.command && open ~/.cache/fleet-setup/install.command
```

Go on to step 2 while it runs. Use the wait (see "While something runs").

## 2. Ask everything in one call

Ask these questions now, in one call of your question tool. Then the install
and the setup do not wait for the person. Setup notes can add questions
later (step 6). Leave out each question that the picks from the page
already answer. On a rerun of setup (step 1), leave out the Packs question:
setup starts from the packs in their profile.

1. **New to you.** A multi-select question: "Which of these are new to you?"
   with T3 Code (the app you are talking in), Fleet (what it sets up),
   Devboxes (Linux machines in the cloud, such as Coder workspaces, where
   agents keep working while the Mac sleeps), and "None, I know all three".
2. **Where Fleet runs**, with the options of step 4.
3. **Packs**, with the options of step 6.
4. **AI plan**, with the options of step 6.

Each pick in question 1 adds an explainer to a later step:

| New to | Add |
| --- | --- |
| T3 Code | In step 3: a **thread** is one agent conversation with its own task. A **worktree** is a separate checkout of the same repo, so several threads change code at once without touching each other. T3 Code shows every machine's threads on the Mac and the phone. |
| Fleet | In step 3: the picture, and one pack from step 6 with one of its workflows as an example. |
| Devboxes | In step 4: what a hub and a node are, and why agents run better on them. |

When the packs are "One by one", ask the multi-select of step 6 right after.

## 3. Show what Fleet is

Fetch the picture from
`https://raw.githubusercontent.com/Silthus/fleet-engine/main/docs/fleet.svg`
and show it. Then say: Fleet installs agent rules, skills, and workflows. A
**workflow** is one way of working that agents follow, such as a draft pull
request for every fix. A **pack** is a set of workflows that you turn on as
a whole. Your answers go to your **profile**, a private GitHub repo named
`fleet-profile`, so every machine you add gets the same setup. A team pack
can keep its members' profiles in the team's GitHub org instead, as
`fleet-profile-<login>`, so teammates can read each other's setup.

## 4. Where Fleet runs

Step 2 asks "Mac only, or Mac plus a hub and nodes?", with these options,
unless the picks from the page say where Fleet runs:

- **Mac only.** A full setup: the skills and rules of every pack they pick,
  and the workflows that run on a Mac, run on this Mac. Agents stop when the Mac
  sleeps. Workflows that need an always-on machine, such as the loops and
  the PR digest, wait until a node runs. A hub and a node can come later.
- **Mac plus a hub and one node.** Two Linux devboxes in the cloud that stay
  on while the Mac sleeps: one **hub** with a 200 GB disk, which links your
  machines and watches their disks, and one **node** with a 500 GB disk,
  where threads do the work. Setup creates them at once, while the Mac is set
  up. Add more nodes later, when the load grows.
- **Mac plus a hub and two nodes.** The same, with two nodes, so twice as
  many threads run at once. The hub and two nodes use all 3 machines of a
  free T3 Connect account, so T3 Connect on this Mac then needs a paid T3
  Chat plan. They can name more nodes in their own answer. Three or more
  nodes need a paid T3 Chat plan.

Recommend a hub and one node when they use Coder, and Mac only otherwise.
They use Coder when `command -v coder` finds the Coder CLI. Check it after
the PATH line and before step 2, so the recommendation is ready in the same
call.
The picks from the page line `Mac plus a hub and a node` means one node.
Below, "the nodes" means as many as they chose.

By default, T3 Code on the Mac starts new threads on the nodes, not on the
Mac or the hub: each `fleet devbox add` of a node sets this up. A choice they
already made in T3 Code's load balancing settings stays.

**T3 Connect's limit.** A free T3 Connect account links up to 3 machines.
Each hub and node uses one, the Mac uses one when T3 Connect is on there, and
so does every other machine already on their account, such as an old hub
that they keep until its replacement works. Machines reached only over SSH or
paired directly use none. Before step 5 creates anything, count the machines
on their account, from the T3 Connect page in T3 Code's account menu, plus
the new ones. When the count is over 3, say so and let them choose: fewer
nodes, removing a machine they no longer use from that page, or a paid T3
Chat plan, which they link in T3 Code's account menu under **T3 Chat** →
**Link T3 Chat** (up to 10 machines with Pro).

The Mac is ready to use first in both cases. With a hub and nodes, step 5
creates them while the Mac is set up, and step 9 sets them up after.

When a pick from the page names a hub and nodes, repeat it with the disk
sizes, and that you create them in step 5. They can tell you to stop.

## 5. Install the tools

The install from step 1 runs in the background. It is done when
`~/.local/bin/fleet help` prints the list of commands. When it stops with an
error, explain its last lines, fix what they name, and run it again: it
continues from where it stopped. Use the wait (see "While something runs").

With a hub and nodes, use this wait to create them. Run items 1 to 5 of
step 9 now. On a rerun of setup, step 1 starts no install: run items 1 to 5
before step 7.

- After item 1, run `coder list`. When it lists a workspace whose name
  starts with `fleet-`, an earlier setup may have made it. Ask the reuse
  question of step 9 now, and show the list. Reuse means no `coder create`
  for that workspace. When it lists none, do not ask.
- In item 4, start each `coder create` in the background, all at once. They
  take minutes. Continue with step 6 while they run, and read the output of
  each one when it ends.
- In item 5, run only `coder config-ssh --yes`. Before item 6 of step 9,
  check that `ssh coder.<name> true` passes for each workspace.

## 6. What they want

Step 2 asks these. Skip the packs question when the picks from the page name
the packs:

- **Packs.** One option per preset in `~/.cache/fleet-setup/presets.json`,
  with its `blurb`, and "One by one". For one by one, ask a multi-select
  question with the packs below whose row says "Always", plus those whose
  row fits their answer in step 4. A pack whose row says "Step 9" needs a
  hub that runs, so step 9 offers it. Base is always on.
  [The Fleet page](https://silthus.github.io/fleet-engine/) shows what each
  pack does.
- **AI plan.** Claude, ChatGPT, or both: it decides the sign-ins and the
  model defaults. Recommend the agent they set up in T3 Code
  (`claude auth status` or `codex login status` passes).

For each pack they pick whose row names a setup note, read that note in
`~/.local/share/fleet/engine` once the install is done, and follow it in
step 7. Read only the notes of the packs they picked. Ask the questions of
all the notes together, in one call, before step 7.

| Pack | What it does | Offer it | Setup note |
| --- | --- | --- | --- |
| `pull-requests` | Every fix or feature ends as a proven, reviewed draft pull request, and ship words take it to merged. | Always | None |
| `orchestration` | Big work becomes a map of tickets that a conductor thread works through, and side work gets its own thread. | Always | `packs/orchestration/SETUP.md` |
| `communication` | Agents write in your voice, give short updates, and share plans and previews as links. | Always | None |
| `memory` | Agents on all your machines share what they learn through your own private memory repo. | Always | `packs/memory/SETUP.md` |
| `recovery` | Threads that stop on a usage limit or a provider outage continue once the provider answers again, and fleet providers says which provider has capacity. | Step 9 | `packs/recovery/SETUP.md` |
| `guards` | Hooks stop an agent's shell commands from running network code, using GitHub outside your owners, pushing past review, or polling in loops. | Always | `packs/guards/SETUP.md` |
| `slack` | Your own message, reaction, or mention in Slack starts a T3 thread about it. | With Mac only, or in step 9 | `packs/slack/SETUP.md` |
| `hub` | One always-on devbox manages the others. It keeps your devboxes linked and watches their disks. | Step 9 | `packs/hub/SETUP.md` |
| `mcp-gateway` | The hub signs in to your MCP servers once, and agents on every machine reach them through it. | Step 9 | `packs/mcp-gateway/SETUP.md` |

## 7. Run setup with their answers

Build the command from the answers, so setup asks nothing twice:

```sh
fleet setup --chat --preset <id> --plan <claude|codex|both> --devbox skip
```

For one by one, use `--preset starter`, add `--remove pull-requests` when
they did not pick it, and add `--add <pack>` once per other pack they picked.

Start it in the background and read its output as it comes. One run does
the whole setup: it waits for each sign-in that ends in the browser and opens
the browser itself. While it runs:

- **A sign-in starts** (`▶ Sign in to …`). Say what it is for, from the table
  below, and give the person any one-time code the output shows. Setup goes
  on by itself once they finish in the browser.
- **`✓ Ready to use.`** Tell the person they can start a new thread in T3
  Code now. The steps it names go on in the background; say what each one
  does.

When it ends with code `2`, it lists what it still needs:

- **A line `--set <pack.key>=<value>   <question>`.** Ask the question with
  your question tool, then add `--set <pack.key>=<answer>` to the command.
- **A line `Needs you: <sign-in>`, then `In a terminal, run: <command>`.**
  It needs the person's keyboard, for example to paste a token. Say what it
  is for, then run it in Terminal (see "The keyboard in Terminal").

Then run the same command again. Every step skips what is done. On any other
stop, read the last lines, explain them, and fix what they name. Use each
wait (see "While something runs").

| Sign-in | What it is for |
| --- | --- |
| GitHub | Once, with every permission Fleet needs: it creates their private `fleet-profile` repo, adds their SSH keys, and reads their org's packs. |
| Claude | Claude Code on this Mac uses their Claude plan. |
| ChatGPT | Codex on this Mac uses their ChatGPT plan. Setup checks it with a real request. With both plans, it comes after the Mac is ready to use, right after setup installs Codex. |

### Another Fleet keeps the files

When setup stops with a `To do:` line that starts with `Another Fleet setup
keeps`, the files it names belong to another Fleet on this Mac. Say how many
files that is, and that they are the same kind of rules and guides Fleet
installs. Ask:

- **Take them over** (recommended): run the `fleet apply --adopt-from <name>`
  that the line names, then the setup command again. Fleet copies the other
  Fleet's state and every file or linked folder it replaces to
  `~/.local/state/fleet/backups/`, and leaves the other Fleet's files that
  this profile does not write as they are.
- **Stop here**: nothing changes, and setup cannot finish while the other
  Fleet keeps the files.

## 8. Check the result

```sh
fleet doctor
```

The step is done when every line is explained to the person:

- `Fix:` Fleet can repair it. Run `fleet apply`, then `fleet doctor` again.
- `To do:` the person does it. Say exactly what and where.
- `Note:` information only.
- `Everything matches your profile.` The Mac is set up.

### When Fleet kept something of theirs

A line that starts with `Kept your` names a file or a setting that the person
had before Fleet, which Fleet left as it was. Never show the raw key alone.
Say in plain words what it controls, what Fleet's value does instead, and
whether `fleet doctor` passes while it stays. Then ask:

- **Take Fleet's version**: run the `fleet apply --adopt <path>` that the
  line names. A line that says `Removed item changed locally` names a file
  that Fleet no longer installs, so there is nothing to take: keep it, or
  move it away by hand. Fleet keeps the new file up to date, and their old
  file stays in `~/.local/state/fleet/backups/`. When the old file holds their own
  skills or rules, agents stop reading them. Say which ones they lose, and
  offer to move the ones they still want to the "About me" file in their
  profile, which agents read after the packs' rules.
- **Keep theirs**: nothing changes, and the line stays in `fleet doctor`. This
  makes sense when they set the value on purpose, such as a model proxy their
  company needs.

Recommend taking Fleet's version, unless they set the value on purpose.

Tell them that a new Terminal window has `fleet` on its `PATH`. With Mac
only, go on to step 10. With a hub and nodes, go on to step 9.

## 9. Add the hub and the nodes

The default is one **hub** with a 200 GB disk and one **node** with a 500 GB
disk, all Coder workspaces, with as many nodes as they chose in step 4. Run
each item on this Mac. Items 1 to 5 start early, in step 5, so the
workspaces are made while the Mac is set up. Items 6 to 10 run here, after
the Mac is ready to use. The person chose a hub and nodes in step 2, so
create them without asking again. Show each command as you start it.
Creating a workspace and `fleet devbox add` take minutes; use each wait
(see "While something runs").

Before item 3 below, run `coder list`, and `fleet hub status` once Fleet is
set up on this Mac. When either names a hub or a Fleet workspace, ask
whether to reuse a hub:

- **Reuse** the hub that `fleet hub status` names: skip items 3 to 7 for
  it. It keeps its links and disk watch. A Coder workspace that runs Fleet
  but is not named as the hub skips items 3 to 6 only.
- **Make a new one** (recommended when no hub is named): when there is no
  hub, or the old one is on another Coder deployment, another account, or a
  disk under 200 GB.

**Clean up what you replace.** When a new hub or node replaces an old
workspace, clean up only after item 10 passes on the new one, and ask before
you remove anything. A workspace from step 5 that `fleet devbox add` never
touched is not a devbox yet. It needs only item 2, after the person says
yes, and it can go at once:

1. Run `fleet devbox remove coder.<old name>` on this Mac. It takes the old
   host out of their profile, unlinks it in T3 Code here, and drops it from
   load balancing. The hub stops its tunnel, disk watch, and link to that
   host at its next `fleet update`. An old hub can go only after
   `fleet hub here` named the new one. When it stops with an error, fix what
   it names and run it again. When it says T3 Code here has no link it can
   find, remove the old machine in T3 Code's Settings → Environments.
2. Delete the old workspace with `coder delete <old name>`.

When devboxes were new to them, explain the hub first: it is the one devbox
that looks after the others. It keeps an SSH tunnel and a T3 link to every
node, and cleans a node's disk before it fills. The node is where threads do
the work. Each machine keeps working when the hub is down.

When step 7 printed that a team pack is ticked, such as `✓ You are in the
<org> org, so the <pack> pack is ticked`, read that pack's setup note first,
when it has one:

```sh
~/.local/share/fleet/sources/<source>/packs/<pack>/SETUP.md
```

`<source>` is the folder in `~/.local/share/fleet/sources` that holds the
pack. A team pack may already have made a devbox in step 7, and its note
says which template, parameters, and devbox to use. Where it differs from
the steps below, follow the note. Step 5 made the workspaces before step 7,
so when the note names another template, or a devbox that the pack already
made, replace the early workspaces: see "Clean up what you replace".

1. **Coder CLI.** When `command -v coder` finds nothing, download
   `https://coder.com/install.sh` to
   `~/.cache/fleet-setup/coder-install.sh`, read it, and run it. It needs
   no Homebrew and no password:

   ```sh
   sh ~/.cache/fleet-setup/coder-install.sh --method standalone --prefix "$HOME/.local"
   ```

   When `coder whoami` fails, sign in. Read their Coder address from
   `~/Library/Application Support/coderv2/url`, and ask for it only when
   that file is missing.
   Coder needs a session token: it lets this Mac act as them in Coder, and
   they make one at `<coder address>/cli-auth`. Ask for it with the secret
   prompt, delivered as a file, and sign in with it:

   ```sh
   CODER_SESSION_TOKEN="$(cat <file>)" coder login <coder address>
   ```

   Without a secret prompt, run `coder login` in a Terminal window, where it
   asks for the token itself:

   ```sh
   printf '#!/bin/sh\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\ncoder login %s\n' '<coder address>' > ~/.cache/fleet-setup/coder.command && chmod +x ~/.cache/fleet-setup/coder.command && open ~/.cache/fleet-setup/coder.command
   ```

   The step is done when `coder whoami` passes.
2. **Template.** List them with `coder templates list`. When there is one,
   use it; ask only when there are more. Read its parameters, the
   `coder_parameter` blocks in its files:

   ```sh
   coder templates pull <template> ~/.cache/fleet-setup/template-<template>
   ```

   Find the disk size parameter. Ask for each parameter without a default.
   When `coder templates pull` fails, open the template's page in the Coder
   web app, `<coder address>/templates/<template>`, and ask the person to
   read you the parameters and their allowed values from it.
3. **Names.** Use `fleet-hub` and `fleet-node-1`, `fleet-node-2`, and so on.
   When `coder list` already has a workspace by that name that they do not
   reuse, add the next free number instead, such as `fleet-hub-2`, so the new
   machine and the one it replaces never share a name. Ask for a name only
   when they want another. Below, `<hub>` and `<node>` stand for them, and
   `<name>` for any of them.
4. **Create.** Create the hub with a 200 GB disk and each node with a 500 GB
   disk, with every parameter on the command line, so Coder asks nothing.
   `--preset none` stops the preset question that `--yes` does not skip, and
   `--use-parameter-defaults` takes the default of every other parameter:

   ```sh
   coder create <name> --template <template> --preset none --use-parameter-defaults --parameter <disk parameter>=<200 or 500> --yes
   ```

   Start them all at once, each in the background.

   Read each create's output when it ends. Once its workspace exists, keep
   it running, because agents work there while the Mac sleeps:
   `coder schedule stop <name> manual`.
5. **SSH.** Run `coder config-ssh --yes`. The step is done when
   `ssh coder.<name> true` passes for each workspace.
6. **Fleet on the hub.** Run `fleet hub status` first. When it names a hub
   that step 5 did not create, ask the reuse question above now. On
   **Reuse**, delete the early hub with `coder delete <name>` after the
   person says yes, and skip items 6 and 7. Otherwise, `fleet devbox add`
   installs Fleet, applies their profile, and links T3 Code. It also signs
   the workspace in to Coder, so the hub reaches the node over SSH. Its
   sign-ins need their keyboard, so run it in a Terminal window:

   ```sh
   printf '#!/bin/sh\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\nfleet devbox add %s\n' 'coder.<hub>' > ~/.cache/fleet-setup/devbox.command && chmod +x ~/.cache/fleet-setup/devbox.command && open ~/.cache/fleet-setup/devbox.command
   ```

   Before it opens, explain its sign-ins from the table in step 4 of
   [Getting started](https://github.com/Silthus/fleet-engine/blob/main/docs/getting-started.md).
   Ask them to tell you when it prints that the host is their devbox now.
7. **Name the hub.** Run `fleet hub here` on the hub. It saves
   `coder.<hub>` as the hub in their profile:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet hub here'
   ```

8. **Hub packs.** Ask with a multi-select question which of these to turn
   on, recommending Hub, unless the picks from the page name the packs for
   once the hub runs. Read the setup note of each one they pick, now:

   - **Hub**: the hub links the machines and watches their disks.
     `packs/hub/SETUP.md`
   - **MCP gateway**: the hub signs in to their MCP servers once.
     `packs/mcp-gateway/SETUP.md`
   - **Recovery**: threads that stop on a usage limit go on by themselves.
     `packs/recovery/SETUP.md`
   - **Slack**, when they did not pick it in step 6: their own Slack
     message starts a thread. `packs/slack/SETUP.md`

   Turn them on here on the Mac. Start from this command, add
   `--add <pack>` for each other pack they picked, and change or add the
   flags their notes name. With picks from the page, leave out `--add hub`
   when the line does not name `hub`:

   ```sh
   fleet packs --add hub --workflows mcp-gateway=off
   ```

   Then have the hub take the change now, not at its nightly update:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet update'
   ```

9. **Fleet on the nodes.** Run `fleet devbox add` again in a Terminal window,
   for each node, one after the other:

   ```sh
   printf '#!/bin/sh\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\nfleet devbox add %s\n' 'coder.<node>' > ~/.cache/fleet-setup/devbox.command && chmod +x ~/.cache/fleet-setup/devbox.command && open ~/.cache/fleet-setup/devbox.command
   ```

   It lists the node in their profile and has the hub take it before the
   node applies, so the hub's tunnels, disk watch, and credentials include
   it. At the end, the hub links the node in T3 Code. It prints two lines
   that start with `✓ The hub` when both worked. When it says the hub did
   not answer, run the `fleet update` command from step 8 again. When it
   says the hub has not linked the node yet, run this, with the node's name:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet peers link coder.<node>'
   ```

   The last line of `fleet devbox add` says which machines T3 Code on the
   Mac starts new threads on. After the last node, ask them to quit and
   reopen T3 Code once, so it reads that.
10. **Check.** Run `fleet doctor` on the Mac, and on each workspace over SSH.
    A command over SSH does not read the workspace's login files, so it sets
    the `PATH` itself:

    ```sh
    ssh coder.<name> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet doctor'
    ```

    Explain each line as in step 8. A `To do:` line on the hub that needs
    their keyboard runs in a Terminal window as `ssh -t coder.<hub>` with the
    same `PATH` line.

To add a node later, when the load grows, run items 3, 4, 5 and 9 above
again with the next node name and a 500 GB disk, then `fleet doctor` on it.

Then go on to step 10.

## 10. Hand over

Add their profile as a T3 Code project named `fleet-profile`, so they can
open a thread there. Skip it when T3 Code already lists that project:

```sh
t3 project add --title fleet-profile ~/.local/share/fleet/profile
```

Then give them these habits, one line each:

- When something does not fit how you work, open a thread in the
  `fleet-profile` project and say what to change. Every machine takes the
  change.
- Fleet keeps itself up to date: each machine runs `fleet update` every night.
- **Side fix.** When an agent finds an unrelated problem, it hands the fix to
  a new thread with its own pull request, and stays on its task.
- **Conductor.** For big work, one thread writes a map of tickets and starts
  one worker thread per ticket.

Leave out a habit whose pack they did not pick: the last two need the
Orchestration pack.
