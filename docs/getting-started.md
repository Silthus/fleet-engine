# Getting started

This guide takes you from a Mac with nothing on it to a Mac and a Coder devbox
that run the same Fleet setup and reach each other through T3 Code. Plan about
20 minutes. Most of it is waiting for installs.

You need:

- a Mac, and your login password for it;
- a GitHub account;
- a Claude plan, a ChatGPT plan, or both;
- a Coder workspace that runs Linux, for the devbox. You can add it later. It
  needs the Linux prerequisites in the [README](../README.md#set-it-up-by-hand): `curl`,
  `git`, `tar`, `sha256sum`, `python3`, cron, and systemd's user manager, with
  lingering on so T3 Code keeps running after you log out.

## 1. Run the install line on the Mac

Open Terminal and run this as yourself, not with `sudo`:

```sh
curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh | sh
```

`get.sh` installs the Command Line Tools, Homebrew, the GitHub CLI, Bun, and
T3 Code when they are missing. Then it starts `fleet setup`. Setup asks
plain-language questions. Where it shows a default, press ↵ to take it.

Setup asks you to sign in. Each sign-in opens a page in your browser, and
setup goes on by itself when you are done:

| Sign-in | What it asks |
| --- | --- |
| GitHub | A code from the terminal on `github.com/login/device`, then your approval. Fleet asks for `repo`, `read:org`, `admin:public_key`, and `admin:ssh_signing_key` once, so it can make your profile repo and add your keys. |
| Claude | Your Claude account, in the browser. Only when your plan includes Claude. |
| ChatGPT | Your ChatGPT account, in the browser. Only when your plan includes Codex. Setup checks the sign-in with a real request, because a stale sign-in still looks signed in. |

Setup creates the private repo `fleet-profile` in your GitHub account and saves
your answers there. Then it applies your packs to the Mac and checks the result
with `fleet doctor`. It ends with a screen that lists your packs and what runs
by itself.

If you stop, or a step fails, run the same line again. Every step skips what is
done.

When setup ends, open a new terminal window. `get.sh` added `fleet` and the
other tools to your `PATH` in your login file, and only a new terminal reads
it.

## 2. Turn on T3 Connect on the Mac

```sh
t3 up --connect
```

It asks you to sign in to T3 Connect in the browser. With T3 Connect on, a
devbox you add next can link back to the Mac. Without it, the Mac still reaches
the devbox, but not the other way round.

## 3. Make the Coder workspace an SSH host

Fleet reaches the devbox over SSH. Install the Coder CLI, sign in, and write
the SSH hosts for your workspaces:

```sh
coder login <your Coder URL>
coder config-ssh
```

Check that it works. With the default prefix, a workspace named `dev` is the
host `coder.dev`:

```sh
ssh coder.dev true
```

## 4. Add the devbox

```sh
fleet devbox add coder.dev
```

Fleet runs these steps on the devbox, in this order. It shows each one as it
starts:

| Step | What it asks |
| --- | --- |
| Install Fleet | Nothing. It runs `get.sh` on the devbox at the engine ref your profile pins. |
| Sign in to GitHub | It opens `github.com/login/device` on the Mac. Type the code that the devbox prints. |
| Apply your profile | Nothing. It clones your `fleet-profile` repo on the devbox and applies it. |
| Sign in to Claude | It opens an SSH terminal. Open the link it prints, sign in, and paste the code back into that terminal. |
| Sign in to ChatGPT | Open the link it prints and type the code it shows. |
| Link T3 Connect | Open the link that `t3 up --connect` prints on the devbox and sign in. |
| Link T3 Code | Nothing. It pairs T3 Code on the Mac with the devbox, and back when T3 Connect is on here. |

When it ends, it prints that the host is your devbox now. T3 Code on the Mac
lists it as an environment.

If a step stops, run `fleet devbox add coder.dev` again. It picks up where it
stopped.

If you write the SSH hosts before step 1, `fleet setup` asks which host is
your devbox and runs the same steps. `fleet devbox` lists your devboxes.

## Change things later

- `fleet packs` lists your packs. `fleet packs --add <pack>` and
  `--remove <pack>` turn one on or off.
- `fleet settings` lists your settings. `fleet set <pack.key>=<value>` changes
  one.
- `fleet doctor` checks a machine against your profile without changing it.
- `fleet update` moves the engine and your profile forward. Each machine also
  runs it every night.

[A day with Fleet](https://silthus.github.io/fleet-engine/) shows what each
pack does during a workday.
