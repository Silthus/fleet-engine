# Fresh-Linux-user proof

`fresh-linux.sh` proves that a newcomer on a fresh Linux machine gets a working
Fleet from the public one-liner, and that a devbox gets the same setup from
the profile repo. Run it as root on a throwaway Linux box with systemd and
cron. It never touches the box owner's files, accounts, crontab, or T3 Code.

```sh
sudo sh proof/fresh-linux.sh
```

## What it does

1. It creates user A with a fresh home, an empty `~/.ssh`, and lingering on.
   A runs the one-liner with no environment from the box owner:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Silthus/fleet-engine/main/get.sh | sh -s -- -- --non-interactive --preset everyday --plan both
   ```

   The first run installs Bun, gh, and T3 Code, then stops at the GitHub
   sign-in.
2. A signs in to GitHub: the proof moves the real gh aside and puts a sandbox
   `gh` (`sandbox-gh.sh`) first on A's PATH. The sandbox is the account
   `fleet-proof`, and its repos are bare repos in the proof's work folder.
   A runs the one-liner again. Setup creates the profile repo, applies it, and
   stops at the Claude sign-in, which stays open on purpose.
3. It creates user B, clones the profile repo A made, and runs its
   `install.sh`, the way a devbox does.
4. It checks each user, and prints `PASS` or `FAIL` per check:
   - the Git author is `fleet-proof`, not the box owner;
   - the Claude and Codex settings hold no hub, tunnel, or proxy key;
   - the crontab holds the Base pack's jobs, `worktree-prune` included;
   - `~/.t3/userdata/settings.json` held Fleet's keys before T3 Code's server
     first started;
   - T3 Code runs on a port no other user's T3 Code uses;
   - a new login shell runs `fleet`, from the login file get.sh picks by
     `$SHELL` (`~/.profile` for bash, unless `~/.bash_profile` or
     `~/.bash_login` exists);
   - `codex --version` runs, with no Node installed;
   - `fleet doctor` lists only sign-ins as open;
   - `fleet apply` again, and the one-liner or `install.sh` again, change
     nothing. Caches, logs, and Codex's scratch folder `~/.codex/tmp` do not
     count.
5. It removes both users, their homes, their crontabs, and the work folder.

It exits 1 when a check fails.

## Before the engine repo is public

Set `FLEET_PROOF_ENGINE` to a Git repo or bundle of the engine. The proof then
serves `get.sh` from that copy with `curl file://...`, and sets
`FLEET_ENGINE_REPO` so get.sh fetches the engine from it. On user B,
`install.sh` cannot download get.sh and falls back to `gh api`, which the
sandbox answers from the same copy.

```sh
sudo FLEET_PROOF_ENGINE=/path/to/fleet-engine sh proof/fresh-linux.sh
```

`FLEET_PROOF_REF` picks the engine ref, `main` by default. The copy's `main`
points at the same commit, because setup pins the profile's engine at `main`
and user B's `install.sh` fetches get.sh at that ref.

```sh
sudo FLEET_PROOF_ENGINE=/path/to/engine.bundle FLEET_PROOF_REF=my-branch sh proof/fresh-linux.sh
```

## What is real

Everything but GitHub: get.sh's downloads, the T3 Code installer, the Claude
Code and Codex installs, cron, systemd, and T3 Code's service. The sandbox
`gh` stands in for one GitHub account, and a Git `insteadOf` rule in the
users' environment sends `https://github.com/fleet-proof/` to its bare repos.
Other GitHub URLs, such as the skill sources, stay real.
