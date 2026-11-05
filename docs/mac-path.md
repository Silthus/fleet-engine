# The Mac path of a first run

This document follows a new user on a clean Mac, from `curl … | sh` to the done screen. It maps each step to the code that does it and the test that covers it.

No agent can run a real Mac. Agents work on Linux devboxes. So this document, plus the unit tests it names, is the Mac proof. A test name is written as `file › describe › test`.

"Agent can run" means an agent can run the covered code in a test on Linux, with stubs. It never means an agent ran it on a Mac.

## 1. `get.sh` on macOS: Command Line Tools and Homebrew

**What happens.** `get.sh` refuses root, puts `~/.local/bin` and `~/.bun/bin` on `PATH`, and reads `uname -s`. On `Darwin` it runs `mac_tools`:

1. It puts `/opt/homebrew/bin` and `/usr/local/bin` first on `PATH`.
2. When `xcode-select -p` fails, it runs `xcode-select --install`. Then it waits until `xcode-select -p` passes, checking every 5 seconds. The person finishes the window that macOS opens.
3. When `brew` is missing, it downloads the Homebrew installer and runs it with `/bin/bash`. Under `curl | sh`, standard input is the script itself. So when standard input is not a terminal and `/dev/tty` opens, the installer reads from `/dev/tty`. This lets Homebrew ask for the Mac password.
4. When `brew` is still not on `PATH` after the installer, it stops with "Homebrew installed, but brew is not on PATH."

**Code.** `get.sh`: `mac_tools`, `download`, the `case "$(uname -s)"` block.

**Tests.**

- `src/get.test.ts › get.sh › on macOS installs the Command Line Tools first and waits until they are there` (new)
- `src/get.test.ts › get.sh › on macOS installs Homebrew, gh, and the T3 Code app, then applies the profile`
- `src/get.test.ts › get.sh › under curl | sh, gives the Homebrew installer the terminal so it can ask for the password`
- `src/get.test.ts › get.sh › on macOS with Homebrew present, skips its installer and installs Bun with brew when Bun is missing` (new)
- `src/get.test.ts › get.sh › on macOS stops when the Homebrew installer leaves no brew on PATH` (new)
- `src/get.test.ts › get.sh › passes sh -n`

These tests stub `uname`, `xcode-select`, `curl`, `brew` and `sleep` in a sandbox `PATH` with a temporary `HOME`. They run only on a Linux host: `get.sh` puts the real `/opt/homebrew/bin` first on `PATH`, so on a Mac they could reach the real `brew`. CI runs Linux.

**Agent can run.** Yes, with stubs. The real Command Line Tools window, the real Homebrew installer and the real password prompt need a person on a Mac.

## 2. `gh`, Bun, and the T3 Code app

**What happens.** Still in `mac_tools`:

- `has gh || brew install gh`
- `has bun || brew install bun`
- `[ -d "/Applications/T3 Code.app" ] || brew install --cask t3-code`

Then, on both systems, `t3_cli` installs the `t3` command from `https://t3.codes/install.sh` with `T3CODE_CHANNEL=nightly`, unless `t3` is on `PATH`. `fetch_engine` fetches the engine at the pinned ref into `~/.local/share/fleet/engine`. With no `--profile`, `get.sh` runs `fleet setup`. Under `curl | sh` it gives `fleet setup` the terminal through `/dev/tty`.

**Code.** `get.sh`: `mac_tools`, `t3_cli`, `fetch_engine`, the last `exec` lines.

**Tests.**

- `src/get.test.ts › get.sh › on macOS installs Homebrew, gh, and the T3 Code app, then applies the profile`: `brew install gh`, `brew install --cask t3-code`, no `brew install bun` when Bun is there, and the nightly `t3` installer.
- `src/get.test.ts › get.sh › on macOS with Homebrew present, skips its installer and installs Bun with brew when Bun is missing` (new)
- `src/get.test.ts › get.sh › under curl | sh, hands fleet setup the terminal so it can ask its questions` (new)
- `src/get.test.ts › get.sh with an existing engine directory › refuses a directory that is not an engine, and an engine with local changes`
- `src/get.test.ts › get.sh › a second run changes nothing`

**Agent can run.** Yes, with stubs. The skip for an existing `/Applications/T3 Code.app` has no test: the path is absolute, and a test cannot make it.

## 3. `fleet setup` on the Mac

**What happens.** `thisMachine` makes a new Mac the `mac` role. It never marks a Mac as a Coder workspace, even when Coder's variables are set. `plan.os` is `darwin` for the `mac` role. Setup then runs these steps in order:

1. **Install the basics**: checks that `git`, `gh`, `bun` and `t3` are on `PATH`.
2. **Sign in to GitHub** (section 9).
3. **Packs**, then **AI plans**.
4. **Pack settings** marked `ask: setup`. A team pack can add its own, such as a setting with a default from the time zone.
5. **Profile**: Fleet creates the private profile repo and pushes the answers.
6. **Set up this Mac**: runs `fleet apply` with the profile. This writes the T3 settings (section 4), the launchd jobs (section 5) and the identity (section 7). It also runs the pack steps for `darwin` (section 8).
7. **Pack human steps**, such as a team pack's sign-in (section 8).
8. **Your devbox**: without the PostHog pack, setup offers an SSH host from `~/.ssh/config`, or a skip.
9. **Sign in to Claude**, then **Sign in to ChatGPT**, for the chosen plans only.
10. **Devbox steps** for a chosen SSH host (section 9).
11. **Check everything**, then the done screen with a "This Mac" row.

**Code.** `src/profile/profile.ts` (`thisMachine`); `src/reconciler/resolve.ts` (`os` from the role); `src/setup/setup.ts` (`setup`, `setupSteps`, `bootstrapStep`, `applyStep`); `src/setup/questions.ts`; `src/setup/done.ts` (`doneScreen`).

**Tests.**

- `src/profile/profile.test.ts › machine file › a new Mac is a mac and never a Coder devbox, even with Coder's variables set` (new)
- `src/setup/setup.test.ts › fleet setup questions › on a Mac, saves the mac role, offers a devbox, and sets up this Mac` (new)
- `src/setup/setup.test.ts › fleet setup questions › asks packs and plans with defaults, shows progress, and moves the answers into the profile`. It runs as a Linux machine, but the steps share every line of code except the role and the title.
- `src/setup/questions.test.ts › a setting's time-zone default › picks eu in Europe/Berlin`, and the other tests in that block.
- `src/setup/done.test.ts › … › sums up this Mac, the profile, and what runs by itself, then gives a first prompt`
- `src/reconciler/resolve.test.ts › … › limits items by os and role`

**Agent can run.** Yes. Setup takes the platform as an option, and the tests pass `darwin`.

## 4. T3 Code settings before T3's first start

**What happens.** `brew install --cask t3-code` installs the app but does not open it. So the T3 server does not answer during setup's apply step. In that case the T3 adapter writes the settings files directly:

- `~/.t3/userdata/settings.json`: the keys the packs set for T3.
- `~/.t3/userdata/desktop-settings.json`, on the Mac only: `updateChannel: "nightly"` and `updateChannelConfiguredByUser: true`. Fleet keeps a channel that the person picked in T3 Code.

Fleet records what it owns in `~/.config/fleet/t3-settings.json`. On the Mac the adapter never touches a service. T3 Code runs as the desktop app. Projects and scheduled tasks wait for the first `fleet apply` after T3 Code starts. The nightly `fleet-update` job does that apply.

The spec names this phase `seedT3`. `seedT3` exists in `src/adapters/t3/adapter.ts`, but only tests call it. In the product, `t3Adapter().apply` calls the same `reconcileSettings` when no server answers.

**Code.** `src/adapters/t3/adapter.ts` (`t3Adapter`, `seedT3`, `targets`); `src/adapters/t3/settings.ts` (`desktopFields`, `reconcileSettings`, `desktopTarget`).

**Tests.**

- `src/adapters/t3/t3.test.ts › seedT3 › sets the nightly update channel in desktop-settings.json on the Mac only`
- `src/adapters/t3/t3.test.ts › seedT3 › keeps an update channel the user picked in T3 Code`
- `src/adapters/t3/t3.test.ts › seedT3 › keeps a channel the user picked when T3 leaves the build's default channel out`
- `src/adapters/t3/t3.test.ts › T3 on Linux › does not touch the service on the Mac`
- `src/adapters/t3/t3.test.ts › T3 adapter guards › doctor reports each missing piece and writes nothing` (a `darwin` plan)

**Agent can run.** Yes, against a temporary `HOME`. Two things need a Mac: whether the real T3 Code app reads the seeded files on its first start, and how Fleet finds the app's server. `serverCli` in `src/adapters/t3/session.ts` reads `ps` and the `.app` bundle path on the Mac. It has no test.

## 5. launchd jobs

**What happens.** On `darwin` the Jobs adapter uses launchd, not cron. The Mac gets `fleet-update` (daily, 03:17), `agent-update` (daily, 03:47) and `worktree-prune` (every 5 minutes) from the Base pack, and `memory-sync` (every 5 minutes) with the Memory pack. The Orchestration T3 tasks are for devboxes and hubs only.

For each job:

1. **Launcher.** It writes `~/.local/state/fleet/jobs/<id>.sh`. Its `PATH` has `/opt/homebrew/bin` on the Mac.
2. **Plist.** It writes `~/Library/LaunchAgents/dev.fleet.<id>.plist` with the label `dev.fleet.<id>`. It runs `/bin/sh <launcher>` and logs to `<id>.log`. A daily job uses `StartCalendarInterval`; a frequent job uses `StartInterval`. It escapes `&`, `<` and `>` in paths.
3. **Load.** It runs `launchctl bootstrap gui/<uid> <plist>`, and reports a job that launchd does not load. Before it replaces or removes a loaded job, it runs `launchctl bootout` and checks with `launchctl print` (exit 113 means gone).
4. **Ownership.** It keeps a copy of each plist it wrote in `~/.local/state/fleet/jobs/<id>.plist`. It touches a `dev.fleet.*` plist only when the plist matches what Fleet wants or what Fleet last wrote. Otherwise it leaves the file alone and asks the person to move it.
5. **Removal.** A dropped job loses its agent, launcher and copy. Agents with other labels are never touched. While a pack source cannot be fetched, every Fleet agent stays.

**Code.** `src/adapters/jobs/adapter.ts` (`reconcileLaunchd`); `src/adapters/jobs/launchd.ts` (`plist`, `labelPrefix`); `src/adapters/jobs/launcher.ts`; `src/adapters/jobs/schedule.ts` (`launchdTimer`).

**Tests.** In `src/adapters/jobs/jobs.test.ts › launchd jobs on a Mac`:

- `writes a dev.fleet plist that runs the launcher script, and loads it`
- `escapes &, <, and > in the plist's paths, so a home with them still loads` (new)
- `reports a job that launchd does not load, and loads it on the next apply` (new)
- `keeps an agent that launchd does not stop`
- `keeps an agent and its launcher when launchd cannot say whether the agent stopped`
- `keeps the old launcher when launchd does not stop the agent it would update`
- `leaves a dev.fleet plist that Fleet did not write alone`
- `leaves an agent alone once someone edits the plist Fleet wrote`
- `saves its copy of an agent that already matches, so a later change still applies`
- `removes the copy and launcher of a dropped job whose agent is already gone`
- `uses an interval for frequent jobs, reruns without reloading, and removes only its own agents`
- `keeps every agent, launcher, and copy until a pack source that cannot be fetched is back` (new)

**Agent can run.** Yes, with a fake `launchctl`. Real `launchctl` exit codes and a real job firing need a Mac.

## 6. The account-home lookup

**What happens.** Before the Jobs, Identity and T3 adapters change anything, `skipOtherHome` compares `HOME` with the account's real home. On a Mac, `accountHome` asks `/usr/bin/dscacheutil -q user -a uid <uid>` and reads the `dir:` line. When `dscacheutil` is missing or gives no home, it reads `/etc/passwd`. It never asks `getent` on a Mac. When no home is found, the adapter changes nothing and reports one finding. When `HOME` is another folder, such as a test's temporary `HOME`, the adapter changes nothing and reports nothing.

**Code.** `src/adapters/run.ts` (`accountHome`, `directoryHome`, `passwdHome`, `skipOtherHome`).

**Tests.** In `src/adapters/run.test.ts`:

- `account home lookup › reads the home folder from the Mac directory service answer`
- `account home lookup › asks the Mac directory service for the uid`
- `account home lookup › on a Mac, falls back to /etc/passwd when dscacheutil is missing or knows no home, and never asks getent` (new)
- `the jobs adapter's home guard › …`, `the identity adapter's home guard › …`, `the t3 adapter's home guard › …`: three tests each.

**Agent can run.** Yes, with fake sources. The real `dscacheutil` answer on a current macOS needs a Mac.

## 7. Identity

**What happens.** The Identity adapter takes the name and email from `gh api user`. The default signer, `ssh`, makes `~/.ssh/fleet_ed25519` with `ssh-keygen`. It registers the key on GitHub twice, for authentication and for signing. It writes `~/.config/fleet/gitconfig` and adds an include to `~/.gitconfig`. The `ssh` signer has no Mac branch. The opt-in `1password` signer uses `/Applications/1Password.app/Contents/MacOS/op-ssh-sign` on the Mac. `gh` comes from Homebrew (section 2), and its sign-in is in section 9.

**Code.** `src/adapters/identity/adapter.ts`, `signers.ts` (`signer`, `onePasswordPrograms`), `github.ts`, `gitconfig.ts`.

**Tests.** In `src/adapters/identity/identity.test.ts`:

- `the ssh signer › takes name and email from GitHub, makes a key, and registers it for authentication and signing`, and the rest of that block. They use a Linux plan; the code is the same on the Mac.
- `the 1Password signer › signs through op-ssh-sign with the saved public key` (a `darwin` plan)
- `the 1Password signer › asks for the public key of the 1Password SSH key`

**Agent can run.** Yes, with a fake `gh` and `ssh-keygen`. The real key registration and a signed commit on the Mac need a person.

## 8. Team packs

A team pack, such as the PostHog pack, is not part of this repo. Fleet fetches it only for members of its GitHub org. It adds its own steps, human steps and files to the Mac and the devbox. The team pack's own repo traces those steps and their tests.

**In this engine.** During setup's apply step, `apply` runs the team pack's steps for `darwin`. It skips a step whose `after` names a human step whose probe does not pass yet (`waiter` in `src/reconciler/apply.ts`). Then setup runs the pack's human steps. An interactive one runs in the foreground with the keyboard (`packSignIn` and `withKeyboard` in `src/setup/human.ts`). When its probe passes, the waiting steps run. With the PostHog pack, setup asks no SSH devbox question.

**Tests in this engine.**

- `src/setup/human.test.ts › … › a member of the PostHog org gets its pack ticked, and the pack's sign-in runs its waiting steps`
- `src/setup/human.test.ts › … › an interactive pack sign-in runs in the foreground with the keyboard, then its probe decides, with no polling`
- `src/setup/human.test.ts › … › an interactive one reads the keyboard through a pseudo-terminal while setup's own input is not the terminal`
- `src/reconciler/resolve.test.ts › … › limits items by os and role`

**Agent can run.** The engine side, yes, with stubs. A team pack's real sign-ins need a person with an account.

## 9. Sign-ins and T3 Connect

| Sign-in | Command | Probe | Code | Tests |
| --- | --- | --- | --- | --- |
| GitHub | `gh auth login --web` with four scopes, or `gh auth refresh` when scopes are missing; then `gh auth setup-git` | `gh auth status` lists the four scopes | `src/setup/signins.ts` `githubSignIn` | `src/setup/human.test.ts`: `GitHub opens the device page, polls every 2 s with no key press, and asks for all four scopes`; `GitHub refreshes a sign-in that lacks scopes, and a run without a person only lists it`; `GitHub sets up Git's credentials before a team pack is fetched, and checks the active account` |
| Claude | `claude auth login` | `claude auth status` says `loggedIn` | `signins.ts` `claudeSignIn` | `src/setup/human.test.ts`: `Claude and ChatGPT advance on their probes, only for the chosen plans, and the ChatGPT probe is isolated`; `a sign-in command that fails, or is missing, stops setup with what to do instead of waiting` |
| ChatGPT (Codex) | `codex login` | a real `codex exec` in a temporary folder, 20 s timeout | `signins.ts` `chatgptSignIn` | the same two tests |
| A team pack's sign-in | the pack's human step | the step's probe | section 8 | section 8 |

A human step opens the browser with `open` on the Mac (`realMachine.openUrl` in `src/setup/commands.ts`). It polls its probe every 2 seconds.

**T3 Code app sign-in and T3 Connect on the Mac.** Spec step 13, "T3 Code app sign-in, then the agent link both ways", was never built for the Mac. No step signs in to the T3 Code app on the Mac, or turns on T3 Connect there. What exists:

- **SSH-host devbox** (no PostHog pack): `devboxSteps` in `src/setup/devbox.ts` runs `t3 up --connect --yes --headless` on the box. Then `linkBothWays` links the box from the Mac with `t3 pair` and `t3 environment link`. The box links back only when T3 Connect is already on the Mac. Otherwise setup prints one line that says how to turn it on. Tests: `src/setup/devbox.test.ts`: `installs Fleet on the chosen host, signs it in with the codes shown here, applies the profile, and links T3 Code both ways`, and `links back from the devbox when T3 Connect is on here, and installs the engine of a tracking profile from main`.
- **A team pack's devbox**, such as the PostHog pack's: setup has no T3 link step at all.
- **Every apply**: `checkLinks` in `src/adapters/t3/adapter.ts` reports expired and unreachable links. Test: `src/adapters/t3/t3.test.ts › T3 adapter with a running server › reports expired and unreachable links without failing the apply`.

**Agent can run.** The setup logic, yes, with a fake machine. Every real sign-in needs a person.

## Steps no agent can run

Each step is for a person on a clean macOS user account.

1. Run the public `curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh | sh` in Terminal.
2. Finish the Command Line Tools window when it opens.
3. Type the Mac password once when Homebrew asks for it.
4. Check that `gh`, `bun`, `t3` and `/Applications/T3 Code.app` exist when `get.sh` ends.
5. Approve the GitHub device code in the browser that setup opens.
6. After the step "Set up this Mac", check that `claude --version` and `codex --version` work. The Base pack's `claude-cli` step installs Claude, and its `codex-cli-mac` step installs Codex from the Homebrew cask, for the chosen plans only.
7. Finish `claude auth login` and `codex login` in the browser.
8. With a team pack: finish its sign-ins. Its own repo lists what to check.
9. Before you open T3 Code, check that `~/.t3/userdata/desktop-settings.json` holds `"updateChannel": "nightly"`. Then open T3 Code and check that it starts on the nightly channel with the seeded settings.
10. Run `launchctl print gui/$(id -u)/dev.fleet.fleet-update` and check that the job is loaded. The next day, check `~/.local/state/fleet/jobs/fleet-update.log`.
11. Make a commit in any repo and run `git verify-commit HEAD`.
12. Run `fleet doctor` and check that it passes.

## Gaps

- **Agent CLIs on the Mac, fixed here.** The Base pack's `claude-cli` and `codex-cli` steps ran only on Linux, so a clean Mac stopped at "Sign in to Claude" with "claude is not installed here". Now `claude-cli` runs on every machine. On the Mac, Codex comes from the Homebrew cask: the `codex-cli-mac` step runs `brew install --cask codex`. The Bun package of Codex starts with a Node launcher, and a clean Mac has no Node. A clean Linux box has no Node either, so the Linux `codex-cli` step runs `fleet install-codex`. It installs the checked release package from Codex's GitHub releases to `~/.local/bin/codex`. Each step's check (`claude --version`, `codex --version`) skips a CLI that is already there. Test: `packs/base/base.test.ts` › `installs the agent CLIs on a Mac too, Codex from its Homebrew cask, so a clean Mac without Node can sign in`. A person still has to prove both installers on a clean Mac (step 6 above).
- **Spec step 13 is not built.** No T3 Code app sign-in on the Mac, and no T3 Connect on the Mac. With a team pack's devbox there is no T3 link at all.
- **`seedT3` is unused in the product.** The T3 adapter does the same work through `reconcileSettings` when T3 is not running. Nothing calls `seedT3` outside tests.
- **No test:** finding the T3 server on the Mac through `ps` and the `.app` bundle (`serverCli` in `src/adapters/t3/session.ts`).
- **No test:** `open` in place of `xdg-open` on the Mac (`realMachine.openUrl` in `src/setup/commands.ts`). It reads the platform from `node:os`, so a test cannot choose it.
- **No test:** the skip for an existing `/Applications/T3 Code.app`, and `/opt/homebrew/bin` on `PATH` in `get.sh`. Both use absolute paths that a test cannot make.
- **Shell.** The tests run `get.sh` with Linux's `sh`. macOS runs it with its own `/bin/sh`. `sh -n` and the POSIX-only script lower this risk, but only a Mac run proves it.
