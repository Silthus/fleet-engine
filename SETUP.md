# Set up Fleet with the person

You are an agent in T3 Code on the person's Mac. They pasted the prompt from
the Fleet README. Set up Fleet on this Mac with them, from nothing to a
passing `fleet doctor`.

Work as a guide: before each step, say in one or two plain sentences what it
does and why. Run every command yourself. The person answers questions and
does their own sign-ins in their browser.

## 1. Check the machine

Run `uname -s` and `id -u`. Go on when the output is `Darwin` and a user ID
other than `0`. On another system, tell the person that this guide is for a
Mac, and point them at "Set it up by hand" in the README.

## 2. Download the install script

Download it to a file. Keep the script in view, because a pipe into `sh`
hides what runs:

```sh
mkdir -p ~/.cache/fleet-setup && curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh -o ~/.cache/fleet-setup/get.sh
```

Read the file, then tell the person what it does, in a short list: it
installs the Command Line Tools, Homebrew, the GitHub CLI, Bun, and T3 Code
when they are missing; it puts the engine in `~/.local/share/fleet/engine`
and `fleet` in `~/.local/bin`; it adds one `PATH` line to their login file;
and it starts `fleet setup`. Ask with your question tool whether to go on.

## 3. Run it in a Terminal window

Setup asks its own questions and needs the person's keyboard for the Mac
password, so it runs in Terminal, not in your shell:

```sh
printf '#!/bin/sh\nsh ~/.cache/fleet-setup/get.sh\n' > ~/.cache/fleet-setup/fleet-setup.command && chmod +x ~/.cache/fleet-setup/fleet-setup.command && open ~/.cache/fleet-setup/fleet-setup.command
```

Tell the person what to expect there: setup asks plain-language questions and
shows a default for each, which ↵ takes. It opens their browser for each
sign-in: GitHub (for their profile repo and keys), then Claude, ChatGPT, or
both. Then ask with your question tool to tell you when Terminal shows the
screen that lists their packs, or when it stops with an error.

On an error, read the last lines they paste, explain them, and run the
`.command` file again. Every step skips what is done.

## 4. Check the result

```sh
~/.local/bin/fleet doctor
```

The step is done when every line is explained to the person:

- `Fix:` Fleet can repair it. Run `~/.local/bin/fleet apply`, then
  `fleet doctor` again.
- `To do:` the person does it. Say exactly what and where.
- `Note:` information only.
- `Everything matches your profile.` Setup is done. Tell them that a new
  Terminal window has `fleet` on its `PATH`, and that
  [A day with Fleet](https://silthus.github.io/fleet-engine/) shows what each
  pack does.
