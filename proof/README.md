# Fresh-Linux-user proof

`fresh-linux.sh` proves that a newcomer on a fresh Linux machine gets a working
Fleet from the public one-liner, and that a devbox gets the same setup from
the profile repo. Run it as root on a throwaway Linux box with systemd, cron,
`ss`, and python3. It never touches the box owner's files, accounts, crontab,
or T3 Code. It stops cron while it runs and starts it again at the end, so a
scheduled job cannot change a home between two snapshots or move the engine
off the copy under proof.

```sh
sudo sh proof/fresh-linux.sh
```

## What it does

1. It creates user A with a new home inside the proof's work folder, an empty
   `~/.ssh`, and lingering on. It refuses to start when a user of that name
   exists. It also writes a systemd drop-in for T3 Code's service,
   `t3code.service`, whose `ExecStartPre=` copies
   `~/.t3/userdata/settings.json` into the work folder when the service first
   starts. Fleet does not manage that drop-in folder. A runs the one-liner
   with no environment from the box owner:

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
   - when T3 Code's service first started, `~/.t3/userdata/settings.json`
     held every key Fleet seeds, with Fleet's values, as Fleet records them in
     `~/.config/fleet/t3-settings.json`;
   - a process of the user's `t3code.service` listens on the port in
     `~/.t3/userdata/server-runtime.json`, and no other process listens on
     that port;
   - a new login shell runs `fleet`, from the login file get.sh picks by
     `$SHELL` (`~/.profile` for bash, unless `~/.bash_profile` or
     `~/.bash_login` exists);
   - `codex --version` runs with no `node` on the user's PATH. When the box
     has its own Node, the check runs with a PATH that leaves out that
     folder, and says so;
   - `fleet doctor` exits 0 with nothing open and no kept values. Fleet's
     doctor reports no sign-ins: the Claude and ChatGPT sign-ins are setup
     steps;
   - `fleet apply` again and `install.sh` again exit 0 with `Applied 0
     changes.`, and the one-liner again exits 2 with only sign-ins open. None
     of them changes the home: file contents, modes, and symlink targets stay
     the same. Caches, logs, and Codex's scratch folder `~/.codex/tmp` do not
     count. For the runtime folders `~/.bun` and `~/.local/share/claude`, the
     proof compares the versions and link targets of `bun`, `claude`,
     `codex`, and `t3` instead.
5. It removes both users, their crontabs, and the work folder with their
   homes. The homes live only in the proof's own new work folder, so cleanup
   never deletes a home outside it. Cleanup removes an account only when its
   home is the proof's home for it. When an account cannot be removed, cleanup
   keeps the work folder and the proof exits non-zero.

It exits 1 when a check fails.

## Proving a local copy

CI proves a pull request's tree this way. Set `FLEET_PROOF_ENGINE` to a Git
repo or bundle of the engine. The proof then serves `get.sh` from that copy
with `curl file://...`, and sets `FLEET_ENGINE_REPO` so get.sh fetches the
engine from it. User B's `install.sh` downloads get.sh from
`raw.githubusercontent.com`, so the proof puts a `curl` first on each user's
PATH that serves that one URL from the copy and passes every other call to the
real `curl`. The check `get.sh source` fails when B's `install.sh` did not
fetch get.sh through it.

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
