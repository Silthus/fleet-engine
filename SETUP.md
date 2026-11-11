# Set up Fleet with the person

You are an agent in T3 Code on the person's Mac. They pasted the prompt from
the Fleet README. Set up Fleet with them, from nothing to a passing
`fleet doctor` on this Mac.

## How you work

- **Guide.** Before each step, say in one or two plain sentences what it does
  and why. Size it to what they know (step 2).
- **Ask with your question tool.** Every choice goes through it, with options
  that say what each one means. Put independent questions in one call.
- **Run every command yourself.** The person answers, approves, and does their
  own sign-ins in their browser. Just before a sign-in opens, say what it is
  for.
- **Show, then tell.** Where a step names a visual, show it as a page in the
  chat when you can (T3 Code shows HTML pages that agents publish). Otherwise
  describe it in three lines of text.
- **One PATH.** Your shell started before the install. Begin every command
  that runs `fleet`, `gh`, `bun`, `claude`, or `codex` with
  `export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";`.
- **The keyboard in Terminal.** A command that needs the person's keyboard
  runs in a Terminal window: write it to a file in `~/.cache/fleet-setup`
  that ends in `.command`, with a `#!/bin/sh` line and the `PATH` line above,
  make it executable, and `open` it. Ask them to tell you when it ends.

## 1. Check the Mac

Run `uname -s` and `id -u`. Go on when the output is `Darwin` and a user ID
other than `0`. On another system, tell the person that this guide is for a
Mac, and point them at "Set it up by hand" in the README.

## 2. Ask what they know

Ask three questions in one call, each with the options "New to me" and "I
know it":

1. T3 Code, the app you are talking in.
2. Fleet, what it sets up.
3. Devboxes: Linux machines in the cloud, such as Coder workspaces, where
   agents keep working while the Mac sleeps.

Each "New to me" adds an explainer to a later step:

| New to | Add |
| --- | --- |
| T3 Code | In step 3: threads, worktrees, and that T3 Code shows every machine's threads on the Mac and the phone. |
| Fleet | In step 3: the picture, then what a pack, a workflow, and the profile are. |
| Devboxes | In step 4: what a hub and a node are, and why agents run better on them. |

Take the plain words for each term from `concepts.json` in the engine. Skip
what they know.

## 3. Show what Fleet is

Fetch the picture from
`https://raw.githubusercontent.com/Silthus/fleet-engine/main/docs/fleet.svg`
and show it. Then say: Fleet installs agent rules, skills, and workflows. A
**pack** is a set of workflows that you turn on as a whole. Your answers go
to your **profile**, a private GitHub repo named `fleet-profile`, so every
machine you add gets the same setup.

## 4. Ask where Fleet runs

Ask "Mac only, or Mac plus a hub and a node?", with these options:

- **Mac only.** A full setup: every pack's skills and rules, and the
  workflows that run on a Mac, run on this Mac. Agents stop when the Mac
  sleeps. Workflows that need an always-on machine, such as the loops and
  the PR digest, wait until a node runs. A hub and a node can come later.
- **Mac plus a hub and a node.** Two Linux devboxes in the cloud that stay
  on while the Mac sleeps: one **hub** with a 200 GB disk, which links your
  machines and watches their disks, and one **node** with a 500 GB disk,
  where threads do the work. Add more nodes later, when the load grows.

Use their answer. Set up the Mac first in both cases.

## 5. Install the tools

Download the install script to a file. Keep the script in view, because a
pipe into `sh` hides what runs:

```sh
mkdir -p ~/.cache/fleet-setup && curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh -o ~/.cache/fleet-setup/get.sh
```

Read it, then tell the person what it installs when missing: the Command Line
Tools, Homebrew, the GitHub CLI, Bun, and the `t3` command. It puts the
engine in `~/.local/share/fleet/engine` and `fleet` in `~/.local/bin`, and
adds one `PATH` line to their login file. Ask whether to go on.

When `command -v brew` finds Homebrew, run it yourself:

```sh
sh ~/.cache/fleet-setup/get.sh --install-only
```

When Homebrew is missing, its installer needs the person's Mac password, so
run the script in a Terminal window and ask them to tell you when it ends:

```sh
printf '#!/bin/sh\nsh ~/.cache/fleet-setup/get.sh --install-only\n' > ~/.cache/fleet-setup/install.command && chmod +x ~/.cache/fleet-setup/install.command && open ~/.cache/fleet-setup/install.command
```

When the Command Line Tools are missing, a Mac window asks to install them;
the person clicks **Install**. The step is done when
`~/.local/bin/fleet help` prints the list of commands.

## 6. Ask what they want

Ask in one call:

- **Packs.** One option per preset in `~/.local/share/fleet/engine/presets.json`,
  with its `blurb`, and "One by one". For one by one, ask a multi-select
  question with the packs below whose row says "Always", plus those whose
  row fits their answer in step 4. A pack whose row says "Step 9" needs a
  hub that runs, so step 9 offers it. Base is always on. The page
  [A day with Fleet](https://silthus.github.io/fleet-engine/) shows each pack
  during a workday.
- **AI plan.** Claude, ChatGPT, or both: it decides the sign-ins and the
  model defaults. Recommend the agent they set up in T3 Code
  (`claude auth status` or `codex login status` passes).

For each pack they pick whose row names a setup note, read that note in
`~/.local/share/fleet/engine` now, and follow it in step 7. Read only the
notes of the packs they picked.

| Pack | What it does | Offer it | Setup note |
| --- | --- | --- | --- |
| `pull-requests` | Every fix or feature ends as a proven, reviewed draft pull request, and ship words take it to merged. | Always | None |
| `orchestration` | Big work becomes a map of tickets that a conductor thread works through, and side work gets its own thread. | Always | `packs/orchestration/SETUP.md` |
| `communication` | Agents write in your voice, give short updates, and share plans and previews as links. | Always | None |
| `memory` | Agents on all your machines share what they learn through your own private memory repo. | Always | `packs/memory/SETUP.md` |
| `recovery` | Threads that stop on a usage limit or a provider outage continue once the provider answers again, and fleet providers says which provider has capacity. | Step 9 | `packs/recovery/SETUP.md` |
| `guards` | Hooks that stop an agent's shell commands from running network code, using GitHub outside your owners, or polling in loops. | Always | `packs/guards/SETUP.md` |
| `slack` | Your own message, reaction, or mention in Slack starts a T3 thread about it. | With Mac only, or in step 9 | `packs/slack/SETUP.md` |
| `hub` | One always-on devbox manages the others: it signs in to your MCP servers once, keeps your devboxes linked, and watches their disks. | Step 9 | `packs/hub/SETUP.md` |
| `mcp-gateway` | The hub signs in to your MCP servers once, and agents on every machine reach them through it. | Step 9 | `packs/mcp-gateway/SETUP.md` |

## 7. Run setup with their answers

Build the command from the answers, so setup asks nothing twice:

```sh
fleet setup --non-interactive --preset <id> --plan <claude|codex|both> --devbox skip
```

For one by one, use `--preset starter`, add `--remove pull-requests` when
they did not pick it, and add `--add <pack>` once per other pack they picked.
Run it, and repeat this loop until it ends with code `0`:

- **A line `--set <pack.key>=<value>   <question>`.** Ask the question with
  your question tool, then add `--set <pack.key>=<answer>` to the command.
- **A line `Needs you: <sign-in>`, then `Run: <command>`.** Say what the sign-in is
  for, from the table below. Start the command in the background, read its
  output, and give the person any one-time code it prints. Open the URL it
  names with `open <url>`. Wait until the command ends. When it asks to
  paste a code, stop it and run it in Terminal (see "The keyboard in
  Terminal").
- **A line `Needs you: <sign-in>`, then `In a terminal, run: <command>`.**
  It needs the person's keyboard, for example to paste a token. Say what it
  is for, then run it in Terminal (see "The keyboard in Terminal").
- **Any other stop.** Read the last lines, explain them, and fix what they
  name.

Then run the same command again. Every step skips what is done.

| Sign-in | What it is for |
| --- | --- |
| GitHub | Once, with every permission Fleet needs: it creates their private `fleet-profile` repo, adds their SSH keys, and reads their org's packs. |
| Claude | Claude Code on this Mac uses their Claude plan. |
| ChatGPT | Codex on this Mac uses their ChatGPT plan. Setup checks it with a real request. |

## 8. Check the result

```sh
fleet doctor
```

The step is done when every line is explained to the person:

- `Fix:` Fleet can repair it. Run `fleet apply`, then `fleet doctor` again.
- `To do:` the person does it. Say exactly what and where.
- `Note:` information only.
- `Everything matches your profile.` The Mac is set up.

Tell them that a new Terminal window has `fleet` on its `PATH`. With Mac
only, setup is done. With a hub and a node, go on to step 9.

## 9. Add the hub and the node

The default is one **hub** with a 200 GB disk and one **node** with a 500 GB
disk, both Coder workspaces. Run each step on this Mac. Before each step that
creates something, show the command and ask whether to go on.

When devboxes were new to them, explain the hub first: it is the one devbox
that looks after the others. It keeps an SSH tunnel and a T3 link to every
node, and cleans a node's disk before it fills. The node is where threads do
the work. Each machine keeps working when the hub is down.

1. **Coder CLI.** When `command -v coder` finds nothing, install it with
   `brew install coder`. When `coder whoami` fails, ask for their Coder
   address and sign in. `coder login` asks them to paste a token, so run it in
   a Terminal window:

   ```sh
   printf '#!/bin/sh\nexport PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\ncoder login %s\n' '<coder address>' > ~/.cache/fleet-setup/coder.command && chmod +x ~/.cache/fleet-setup/coder.command && open ~/.cache/fleet-setup/coder.command
   ```

   The step is done when `coder whoami` passes.
2. **Template.** List them with `coder templates list` and ask which one to
   use. Read its parameters, the `coder_parameter` blocks in its files:

   ```sh
   coder templates pull <template> ~/.cache/fleet-setup/template-<template>
   ```

   Find the disk size parameter. Ask for each parameter without a default.
3. **Names.** Ask for the two workspace names. Recommend `fleet-hub` and
   `fleet-node-1`. Below, `<hub>` and `<node>` stand for them, and `<name>`
   for either.
4. **Create.** Create the hub with a 200 GB disk and the node with a 500 GB
   disk, with every parameter on the command line, so Coder asks nothing:

   ```sh
   coder create <name> --template <template> --parameter <disk parameter>=<200 or 500> --yes
   ```

   Then keep each one running, because agents work there while the Mac
   sleeps: `coder schedule stop <name> manual`.
5. **SSH.** Run `coder config-ssh --yes`. The step is done when
   `ssh coder.<name> true` passes for both workspaces.
6. **Fleet on the hub.** `fleet devbox add` installs Fleet, applies their
   profile, and links T3 Code. It also signs the workspace in to Coder, so
   the hub reaches the node over SSH. Its sign-ins need their keyboard, so
   run it in a Terminal window:

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
   on, recommending Hub. Read the setup note of each one they pick, now:

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
   flags their notes name:

   ```sh
   fleet packs --add hub --workflows boxes=off,mcp-gateway=off
   ```

   Then have the hub take the change now, not at its nightly update:

   ```sh
   ssh coder.<hub> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet update'
   ```

9. **Fleet on the node.** Run `fleet devbox add` again in a Terminal window,
   for the node:

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
10. **Check.** Run `fleet doctor` on the Mac, and on each workspace over SSH.
    A command over SSH does not read the workspace's login files, so it sets
    the `PATH` itself:

    ```sh
    ssh coder.<name> 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; fleet doctor'
    ```

    Explain each line as in step 8. A `To do:` line on the hub that needs
    their keyboard runs in a Terminal window as `ssh -t coder.<hub>` with the
    same `PATH` line.

To add a node later, when the load grows, run steps 3, 4, 5 and 9 again with
a new name and a 500 GB disk, then `fleet doctor` on it.
