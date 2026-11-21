# Changelog

## Unreleased

### Final reads and the judge stop at the review budget

- At the review ceiling, `hedge proof review --scope final` no longer reads
  a production fix that came after the last read. It says the budget is
  spent and what to do: revert each commit of the PR since the last read
  that changes production code, never a merge of the base, and list the
  finding under `## Known issues`. The gate carries the revert. Only the
  user's `--override` runs one more read. A
  HEAD whose commits since the last read are only clean base merges and
  quiet commits, past what the gate carries, still gets its final read.
- The judge in `hedge proof gate` fails at most
  `pull-requests.reviewCeiling` times on a pull request. After that the gate
  runs it no more and says the judge budget is spent. A judge gap on HEAD
  that a decision accepts ends it, as before. A cached verdict still shows.
  A gate holds the lock of the pull request's judge directory while it asks
  the judge, so a second gate at the same moment that finds no saved
  verdict for its inputs stops and names the command that holds it, and gates at once never pass the cap. A gate whose
  process ended leaves its lock to the next gate.

### Threads that ask in prose

- The setting `orchestration.proseTitles` names title starts, such as `⚠️, 🚨`,
  of threads that a job queues messages into. Such a thread may end its turn
  with a decision in prose, and the question guard denies its question cards,
  so a pending card does not hold the queued messages. When T3 cannot be read
  or the guard's kill switch is on, cards pass as before.

### A fresh judge scores the growth

- When the production lines at HEAD pass twice the lines at round 1, a fresh
  bloat judge reads the Problem section of the pull request, the round-1 diff
  and the HEAD diff. It has no part in the review loop. It returns the share
  of HEAD's production lines that the problem does not need, and the hunks it
  would cut. `hedge proof review` prints both with the sanity pass it asks
  for: cut those hunks or justify each. The judge runs once per HEAD, with the
  model of the model table's reviewer row, and `HEDGE_PROOF_BLOAT_JUDGE`
  replaces it.
- The Sanity pass cell of the end table shows the growth ratio and the
  cuttable share, such as `×2.4, 30% cuttable`, before the latest pass.

### Decide alone, and show one table at the end

- The setting `pull-requests.autonomy` sets how often an agent asks about a
  review round or a proof gap. `ask`, the default, keeps the question. With
  `end`, `hedge proof` tells the agent to decide alone as a 🤖 decision, and
  the user reads each one under Decisions in `hedge decision report`.
- A one-way door, an ungraded pull request, a panel gap, and a product gap on
  a critical pull request still go to the user.

### The review loop stops on its own

- A review round runs after another review only when the latest review found
  a blocker or major in production code that the pull request introduced.
  Otherwise `hedge proof review` refuses the round, and only the user's
  `--override` runs it. Give the fixes a final read instead. The first panel
  of a pull request still runs.
- The reviewer reads that behaviour the base has too is not a blocker or a
  major. Such a finding is a minor that starts with `[base]` and cites the
  base line.
- When the production lines at HEAD are more than twice the lines at round 1,
  the next round waits for a sanity pass: cut the pull request back to base
  behaviour, or justify the growth with
  `hedge proof sanity --verdict cut|justified --reason '<why>'`. The end
  table shows the latest pass.

### One end table for the review and the skipped proofs

- The proof receipt and `hedge decision report` print one table: the review
  rounds and final reads, the production lines at round 1 and at HEAD with
  tests and docs apart, and each skipped proof with its reason and who
  accepted it. `hedge proof gate` measures the lines and saves them, so the
  table holds a pull request once a gate ran at its HEAD. A gate saved by an
  older Hedge no longer counts, so run `hedge proof gate` again once.

### The Security pack reads Wiz

- The new **Security** pack has one workflow, `wiz`, off by default. Agents
  on every box read Wiz issues, threats, vulnerabilities and cloud inventory
  through the hub's MCP gateway. The hub signs in to Wiz once, with
  `hedge mcp-gateway sign-in wiz`, and asks for read access only.

### Setup never waits for proxy subscriptions

- On a hub with own-account balancing, `hedge apply` and `hedge setup` no
  longer fail while the proxy holds fewer of your own Claude or Codex
  subscriptions than `hub.proxyAccounts`, none included. The proxy installs
  and runs, and `hedge apply` and `hedge doctor` show a `To do:` line with
  the login command. `hedge cli-proxy accounts` counts the subscriptions
  that work. A subscription whose login expired still does not count, and
  `hedge cli-proxy doctor` still warns about it.
- Each machine keeps Claude Code and Codex on their own sign-ins until the
  proxy serves them. While the proxy answers but holds none of an agent's
  subscriptions, its route check is a `To do:` line, not a failure.
  A node that holds no proxy key from the hub yet, such as one that
  `hedge devbox add` set up, also shows one `To do:` line, not a `Fix:`.
  It names the hub step that adds a subscription, and says that
  `hedge cli-proxy doctor` on the hub prints the command that hands the
  node its key. The route stays out of the node's provider files until
  then. On the hub, a missing key is still a failure.
  `hedge cli-proxy connect` saves the key on a node in that case, so the
  first `hedge apply` after the proxy serves an agent sends it there.
  When the hub hands a box over while the proxy serves none of its agents,
  the hub says, after it runs `hedge apply` on the box, that the box keeps
  its own sign-in until the proxy serves it. On the both plan, `hedge doctor` fails while a
  Codex subscription works but the proxy serves no Codex model. A proxy
  that is down, refuses the key, answers without a model list, or runs a
  plugin Hedge did not install still fails `hedge doctor`.
- A pack check can name a `todo`: when its command exits 4, Hedge prints
  it as a `To do:` line, keeps the config that waits for the check out, and
  fails neither apply nor doctor.
- Apply now writes the provider settings, Claude plugins and MCP servers
  once, after the steps. Just before, it runs each check with a `todo`
  and each check that config waits for, and decides that config from
  those results. So a hub whose proxy was stopped routes Claude Code in
  one apply, and a route never stays at the end of an apply whose check
  found the proxy unsafe. A route that an earlier apply wrote stays while
  the steps run. When an adapter that runs before the steps fails, such
  as Jobs on a job id it refuses, apply still decides and writes the
  provider settings, then fails with that adapter's error. When the
  provider settings fail as well, apply names both errors, that adapter's
  first.
- On the hub, `hedge cli-proxy check` and `hedge cli-proxy check codex`,
  the checks that Hedge's routes wait for, fail while
  `hedge cli-proxy doctor` finds the proxy unsafe: a plugin Hedge did not
  install, panel files that do not match their pins, or, with the Proxy
  panel off, a panel page or plugin that is still there. A link at either
  panel path fails them too, and the check says to remove the link, then
  run `hedge cli-proxy install`. Apply then leaves the route out, or takes
  Hedge's route out. So a hub whose proxy has such a plugin never routes
  Claude Code or Codex to it, and a route that an earlier apply wrote
  leaves at the next apply. A route to a safe proxy stays in place, and a
  `hedge-proxy` Codex table of your own stays.
- `hedge cli-proxy connect` no longer writes Claude Code or Codex
  settings, and runs nothing. It saves the proxy key and says to run
  `hedge apply`, which writes the route and records it. So every route
  that Hedge writes has a record, and turning balancing off takes it off
  at the next apply. When the hub hands a box over, it runs `hedge apply`
  on the box after connect, as one more SSH step with the same time limit
  as the others. When that apply exits nonzero, a timeout included, the
  hub says only the exit code and `hedge box run <box> -- hedge apply`,
  and nothing about the box's sign-in. Only after the apply exits 0 does
  the hub read its proxy lines: when they show that the proxy lists no
  model for an agent, or that the agent cannot reach the proxy, the hub
  says the agent there keeps its own sign-in.
- Hedge removes a Claude Code or Codex setting only when its own record
  says Hedge wrote it. It no longer removes a setting because it points
  at the proxy port 8317. So a Codex provider table of your own, of any
  name, stays with its selector.
- The route to the proxy is one unit: the Claude proxy address and key
  helper, or the Codex `hedge-proxy` selector and table. Apply writes all
  of it or none of it, so it selects no `hedge-proxy` table of your own.
  It removes it together too. When your profile or another pack sets a
  key over any part of the unit, or the route check drops a part, the
  whole unit leaves the plan, for `hedge apply` and `hedge doctor` alike.
  So a profile that sets only its own `env.ANTHROPIC_BASE_URL` gets no
  Hedge key helper beside its gateway, and the gateway never receives
  the hub's proxy key.
- Hedge's route leaves with the settings that only work through it. Each
  time apply removes it, because balancing is off, its check fails, or
  the pool is empty, it also removes a Claude credential beside Hedge's
  proxy address, such as your own `ANTHROPIC_AUTH_TOKEN`, and a Codex
  `model_provider = "hedge-proxy"` beside Hedge's table. So no key goes
  to Anthropic, and Codex selects no table that is gone. A `To do:` line
  names each removed setting, never its value, and says only what apply
  removed. The backup in `~/.local/state/hedge/backups`
  holds the file as it was. Only Hedge's own proxy values form the
  route. The route leaves when a file holds Hedge's proxy value before
  apply and another value or none after it, so a gateway from your
  profile in place of Hedge's proxy address also takes a proxy token
  beside it out, with its `To do:` line. A credential beside the route stays only while its value equals
  the value a pack sets for it now. So a key helper your profile sets in
  the same apply stays and is recorded. A value that differs, such as a
  helper you edited or a proxy token you set by hand, leaves with the
  route even when your profile sets that key, and the `To do:` names it.
  The next apply sets your profile's value. A gateway and key helper from
  your profile are set and removed one by one, as before.
- Only the Hub pack may set Hedge's proxy values:
  `model_provider = "hedge-proxy"`, the `hedge-proxy` Codex provider
  table, `http://127.0.0.1:8317` as the Claude
  `env.ANTHROPIC_BASE_URL`, and `cat "$HOME/.config/hedge/cli-proxy.key"`
  as the Claude `apiKeyHelper`. When your profile or another pack sets one of
  them, Hedge refuses the profile when it loads, and the error names the
  pack and the setting. So no selector of yours can point at Hedge's
  table after the table leaves, and no helper of yours sends the hub's
  proxy key to Anthropic. T3 keys hold no proxy value, so Hedge does not
  check them.
- When an adapter that runs before the steps fails, or a later part of
  the provider config step fails after the settings write, such as a
  malformed `provider-plugins.json`, the error that apply throws holds
  the `To do:` lines from the provider settings it wrote.
  `hedge doctor` reads one result of each check for both the config and
  its line.
- When `hedge cli-proxy connect` fails on a box, the hub names the box and
  the exit code, and the commands that hand over the same key again and
  apply it:
  `hedge box run <box> -- hedge cli-proxy connect < ~/.config/hedge/cli-proxy.key, then hedge box run <box> -- hedge apply`.
  It never prints the box's output. When `hedge apply` on the box exits
  nonzero, the hub names only the exit code and the command to see why,
  as for a failed connect.
- The `Connect <node>:` command that `hedge cli-proxy doctor` prints now
  runs `hedge apply` on the node after connect, and the Provider recovery
  note of the Hub pack says so.
- The notice that a Codex plugin is yours now no longer fails
  `hedge doctor`, as for a Claude plugin.

### A smaller pack set

- Base and Hub are in every Hedge. The site shows them first, without a
  switch, and then groups the picks: how your agents work, what they know,
  and what they reach.
- The Pull requests pack is now titled Quality gates. It also holds the QA
  swarm, the quality loop, the signal loop, the PR digest, `impact`, and
  `codebase-design`. Orchestration keeps maps, side threads, and parking.
- The Context library pack is now part of Memory, and Dream moved from Hub
  to Memory. Memory is in the Everyday preset. The library waits until you
  set `context-library.repo`, and setup no longer asks for it.
- The Recovery pack is now the `provider-recovery` workflow of the Hub pack.
  It needs own-account balancing.
- A profile that still lists `context-library` or `recovery` keeps working.
  Hedge reads the old name as the new pack, turns on only the old pack's
  workflows, moves the step ledger to the new name, and leaves the profile
  as it is. `hedge packs --add` and `--remove` take the old names too.
- Picking Slack, Paging, Memory, or Guards turns on its main workflow. A
  profile from before keeps those workflows off: the next save writes
  `false` for each one it never set, once.
- The Integrations pack stays, but the site no longer shows it.
  The Everything preset still has it.

### Hedge is cloud only

- Hedge runs your agents on a hub and one or more nodes in the cloud. The
  Mac and the phone run only the T3 Code app. The "Mac only" setup is gone
  from the site, `SETUP.md`, the presets, and the docs.
- On a Mac, `get.sh` installs nothing. It only stops and turns off the
  launchd jobs of an earlier Fleet or Hedge there, checks that launchd keeps
  them off at the next login, keeps their files, and points at the setup
  page. The Fleet notice and a failed `hedge update` on a
  Mac point there too.
- The setup agent creates the hub and the nodes with one `coder create`
  each, with every template parameter given and the profile repo as
  dotfiles. `scripts/check-workspace.sh` then checks that each workspace
  runs with no stop time, and the disk size, region, instance type, and
  dotfiles repo of its build. It takes no private value and prints no value
  and no token. The person changes a parameter in the workspace's
  **Settings → Parameters** in the Coder web app, never with the Coder CLI. The agent sets Hedge up on
  the hub over SSH, names the hub right after `hedge setup`, and adds the
  nodes from the hub.
- On a box without a browser, ChatGPT signs in with a device code, and
  Claude in a terminal. When device code sign-in is off, setup says how to
  turn it on, or how to sign in over an SSH port forward.
- Setup starts a new ChatGPT sign-in only when Codex says the old one is
  gone. When Codex cannot tell, setup keeps the sign-in and says why. It
  reads the Codex credentials store from `config.toml` as TOML.
- Setup takes the profile's new commits when it starts, before it reads
  your answers, so a rerun keeps what another machine pushed before it. When
  it cannot reach the profile's origin, it says so and goes on with the copy
  on the machine, as it did before this fetch. The Git error that it prints
  leaves out a user name and password in the origin's address. When
  another machine pushes first, setup stops and keeps its commit. It says to
  commit or discard the changes in the checkout that are not committed, to
  bring it up to date with `git -C <profile> pull --rebase`, or to drop its
  commit when it made one, and then to run the same command again. Two machines that
  save the same profile at the same time can overwrite each other's
  answers, as before.
- Setup takes and saves the profile only on `origin`. When the checkout's
  branch tracks a local branch or another remote, setup stops before it
  commits and says to point the branch at `origin`.
- `scripts/template-parameters.sh` prints a default only for a number, a
  `bool`, or a parameter with a fixed list of values, so no free-text
  default, such as a key, reaches the agent's output.
- Each page of the site carries its own script and styles, so a cached page
  always runs its own script.
- `hedge devbox add` signs a node in to Coder only at the hub's own Coder
  address, and only over HTTPS, checked with no redirect followed. The
  node's own Coder CLI signs in with `coder login --use-token-as-session`:
  the new token goes over SSH on standard input into the environment of
  that one command, never into an argument. It installs a missing Coder CLI
  only from that address over HTTPS, only from an HTTP 200 answer with no
  redirect, and only after the downloaded CLI runs. When the node does not
  reach that address over HTTPS, it makes no token and names the sign-in
  the person does there.
  Before it runs any Coder command on the node, it checks the node's Coder
  `url` and `session` paths and its environment with the shell alone. When
  a path is not a plain file, `CODER_URL` or `CODER_SESSION_TOKEN` is set,
  or the node is signed in at another address as another user, it leaves
  that sign-in alone, makes no token, installs a missing Coder CLI as
  above, and lists the sign-in among the steps for the person. That step
  names the paths to move aside and the variables to remove first. It
  prints no command when the hub's Coder address is plain HTTP, and says so
  when the Coder CLI could not be fetched from the hub's Coder address. It
  runs `coder login` and `coder config-ssh` on the node under
  `timeout -s KILL`. 2 minutes after the command starts on the node, it
  kills them there, with the processes they started that are still in
  their process group. For a connection that stops answering, the hub
  stops its SSH call 150 seconds after it starts that call, and that time
  includes the SSH setup. It removes the token when they fail or time out,
  under `timeout` too: the removal gets TERM after 1 minute, and KILL 10
  seconds after that. When the removal fails or times out, it names the
  token and the command that removes it.
  After the node applies the profile, it asks the node's
  `hedge doctor --to-do` which steps are left. When the apply passed and
  the node finds nothing but those steps, it goes on with the sign-ins,
  T3 Connect and the link, and ends with a list of them, each with its
  command, and a line to run `hedge apply` on the node after them. It runs
  none of them itself. When the apply failed, or the node finds anything
  else, it stops at the profile step, with what `hedge doctor` there
  found. A node with an older Hedge, which has
  no `--to-do`, finishes the step and points to `hedge doctor` there. A
  rerun keeps a node engine that runs the hub's engine commit, when its
  `hedge` command runs. When T3 Code on the hub reaches the node, it says
  so, and does not ask for `hedge peers link`.
- `hedge doctor --to-do` prints the steps left for the person as JSON, and
  before it the other findings. It exits 1 when there are other findings.
  A step that Hedge repairs itself is a finding, never a step for the
  person.

### Fleet is now Hedge

- The product and its command are now Hedge and `hedge`. `get.sh` points
  `fleet` at the same command, so the habit from before the rename keeps
  working.
- To upgrade, run
  `curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh`
  once. It makes a fresh checkout of the engine in
  `~/.local/share/hedge/engine`. It never reuses the old checkout. It ignores
  a `FLEET_ENGINE_DIR` or `HEDGE_ENGINE_DIR` that leads into a Fleet path, by
  its real path, or that is the Fleet checkout: its launcher is `fleet`, or
  its remote is `fleet-engine`. It stops when a Hedge folder is a link into a
  Fleet path.
- Hedge moves only a Fleet engine in `~/.local/share/fleet/engine`. When
  Fleet's `~/.local/bin/fleet` command, the one with the installer's
  `# Fleet` line, runs an engine in another folder, or names a folder that
  Hedge cannot read, such as one with an escaped apostrophe, `get.sh` stops
  before it changes anything and names the folder. `hedge retire-fleet`, its
  dry run, and `hedge apply` refuse on such a machine too. Stop Fleet's
  services, cron jobs and `fleet:` tasks by hand and delete
  `~/.local/bin/fleet`, or move the engine to `~/.local/share/fleet/engine`
  and change the path in `~/.local/bin/fleet` to match, then run `get.sh`
  again. A `~/.local/bin/fleet` without the `# Fleet` line is not Fleet's,
  and Hedge ignores it. When `~/.local/share/fleet/engine` itself is a link,
  `get.sh`, `hedge retire-fleet`, its dry run, and `hedge apply` refuse the
  same way and name the link.
  Stop Fleet by hand and delete the link, or move the engine into its place.
- On the first run, `get.sh` first runs `hedge retire-fleet`, also with
  `--install-only`. When it cannot show that each piece of Fleet stopped, it
  copies and applies nothing and exits 1. Stop what it names by hand, or
  start T3 Code for a task, then run `get.sh` again.
- Once Fleet is stopped, `get.sh` copies the setup from before the rename: the
  profile checkout, the machine file, `~/.config/fleet` with the secret store
  and its event log, Slack's queued launches and the events it handled, the
  SSH key, the step ledger, and the credential folders of the hub proxy,
  the MCP hub, and the hub's HTTPS share. It points the machine file at the
  profile copy only when the copy is the same repository at the same commit
  and loads as a profile. Else it drops the profile and the setup progress
  from the machine file, and setup starts again. It never copies the engine, locks, logs, run state,
  caches, or `node_modules`. It copies each file on its own with its mode,
  skips links, and stops when a link is on the way to a new path. It never
  replaces a file. It copies each missing file into a `~/.config/hedge` that
  was there before, such as the one `hedge devbox add` makes, and leaves any
  other new folder that was there before as it is.
  An import that stopped part way copies the rest on the next run.
- Then `get.sh` runs `hedge apply`.
  `hedge retire-fleet` finds the launchd agents `dev.fleet.*` and
  `com.fleet.*`, the systemd user units `fleet-*`, the `fleet-mcphub`
  container, the `# fleet:` crontab entries, the T3 tasks `fleet:*`, and the
  commands of Fleet's jobs that still run, such as one that cron started. It
  leaves the `fleet-heavy.slice` and any other slice alone, because a slice
  runs nothing by itself. It stops and turns off each one, keeps its files, and checks each one again:
  a launchd agent must be unloaded and disabled, the container stopped with
  the restart policy `no`, and each `# fleet:` entry gone from the crontab.
  It keeps the other crontab entries. It stops a running job command with
  `SIGTERM` and waits up to 10 seconds for it to end. When systemd cannot
  list its unit files, retire fails. While T3 Code is stopped, it reads the
  tasks T3 Code saved, and a `fleet:` task that is on there fails it. A T3
  Code store without a task table holds no tasks. When it cannot show that a
  piece is stopped, it names it and exits 1.
- `get.sh` with `-- --dry-run` is a preview: it neither copies nor stops the
  setup from before the rename, and it names each piece of Fleet that still
  runs. With `--profile`, it also previews the apply. Without `--profile`, it
  runs no setup. `hedge retire-fleet --dry-run` names the same pieces. An
  engine from before `retire-fleet` took `--dry-run` is never asked to list
  them, so a preview at such a `--ref` stops nothing.
- `hedge retire-fleet`, its dry run, and both checks in `hedge apply`, for
  Fleet's jobs and for its `fleet:` T3 tasks, act only on a machine with a
  Fleet engine install in `~/.local/share/fleet/engine`. `get.sh` points
  `fleet` at Hedge only after retire, never in a preview. On any other
  machine, such as
  one that runs a private Fleet copy, retire stops nothing and says that the
  machine has no Fleet engine install, and apply does not wait for that
  copy's `fleet-*` units or `fleet:` tasks. They do not look up the
  account's home folder there.
- To go back to Fleet, follow "Go back to Fleet" in `SETUP.md`.
- `hedge apply` starts nothing while a piece of Fleet still runs, or while it
  cannot tell. It checks before it fetches a source or writes the machine
  file. It names each piece and says to run `hedge retire-fleet`.
  Right before it adds the `hedge:` T3 tasks, it checks T3 Code again, so a
  `fleet:` task that T3 Code turned on as it started during this apply stops
  it. There is no handoff and no rollback: Fleet stops first, then Hedge
  starts.
- `hedge apply` exits 1 when a service, timer, cron job or T3 task it starts
  does not start, when a pack step fails in any pack, and when a check that
  Hedge repairs still fails after the repair. It still runs the other parts.
  `get.sh` keeps its retry marker until apply exits 0, so an identical retry
  after a failed apply runs apply again.
- `hedge doctor` names each piece of Fleet that still runs and fails.
- `hedge devbox add` refuses a profile that pins an engine from before the
  rename, and a box whose `~/.config/hedge` or its `machine.json` is a link.
  Set `engine.ref` in the profile to a Hedge release, or move the link away.
- `hedge update` keeps the engine's origin when the profile still names
  `PostHog/fleet-engine`, so a Hedge checkout never looks like Fleet's.
- `hedge update` refuses an engine ref whose commit has no `hedge` launcher
  file before the checkout moves, and records nothing. Only a regular file
  named `hedge` counts, not a folder or a link. It writes or removes its
  update notice only after the new engine's packages installed, so a refused
  or rolled-back update leaves the notice as it was. It writes the notice
  only to a regular file in a real folder. Before the checkout moves, it
  checks `~/.local/state/hedge`, where `hedge apply` keeps its state. When
  that folder or a folder above it is a link, a file or anything else that is
  not a real folder, `hedge update` names the path, moves nothing and exits 1.
  It checks those folders again just before it writes the notice. When a
  folder changed into a link in between, or only `update.json` is a link,
  leads into Fleet's state folder or cannot be written, it skips the notice
  with a warning and the update goes on. It never writes Fleet's state.
- `hedge update` runs apply with the profile it pulled.
- `hedge update` and `hedge refresh` use the Hedge copy of a profile that the
  machine file still names in a Fleet path, or refuse, before they pull.
- Hedge operations that change the machine take an `flock` lock on
  `~/.local/state/hedge/hedge.lock`. The system lets go of it when the
  process ends, so an import or apply stopped with Ctrl-C does not block the
  next run.
- An engine that runs from a Fleet path, such as `~/.local/share/fleet/engine`
  after the old updater pulled this release, changes nothing. It prints
  `Fleet is now Hedge. Run: curl -fsSL https://raw.githubusercontent.com/PostHog/hedge/main/get.sh | sh`.
  Its scheduled jobs exit 0, so they raise no alert. Its hook runner blocks
  each `PreToolUse`, `PostToolUse` and `UserPromptSubmit` event with exit 2
  and the notice, because the guard hooks behind it do not run, and lets
  other events pass. Every other command exits 1. It checks the path as
  written and with its links resolved.
- Hedge never writes, owns, or removes a file under an old name. It never
  uses or writes a profile in a Fleet path: `hedge apply --profile` uses the
  Hedge copy or refuses, and `hedge set` writes only to the copy. `hedge
  prune` never touches a worktree in a Fleet path, or one whose Git folder is
  in a Fleet path. A Hedge copy of a profile counts only when it is a
  checkout of the same repository, with the commit the old profile is at.
  The profile and machine writers also refuse a file that links into a Fleet
  path. Delete the old paths when you no longer need them.
- Hedge still takes what Fleet wrote: the `fleet-management` key of MCPHub, the Claude key helper and the
  `fleet-proxy` Codex provider of `fleet cli-proxy connect`, a T3 Claude
  instance bound to `~/.config/fleet/recovery/claude`, a gateway upstream
  marked "Added by Fleet", Node links in `~/.local/bin` that point into
  `~/.local/share/fleet/node`, which Base's `node-runtime` step links to
  Hedge's package, since its check `hedge install-node --check` fails while
  they are there, a Codex
  install under
  `~/.local/share/fleet/codex` that Base and the nightly update move to
  Hedge's own, a `fleet-proof-receipt`
  block in a PR, and Git allowlist helpers that say "Fleet blocked Git
  access". The exit-status guard also checks `fleet proof` and
  `fleet heavy --`.
- Crontab lines and T3 worktree scripts from before the rename are replaced
  by the new ones.
- Hedge never edits or removes a `# fleet-hub-tunnel` line in `/etc/hosts`.
  Hedge's own line is `127.0.0.1 <host> # hedge-hub-tunnel <home>`, where
  `<home>` is the `HOME` that installed it. `hedge ssh-tunnels install`,
  `remove`, `left` and `doctor` act only on the line that ends with this
  `HOME`. So a run with another `HOME` does not change the hosts file or call
  `sudo`. Install keeps a Fleet line, or a line of another home, that maps the
  host to `127.0.0.1`. When such a line maps the host to another address,
  install stops, as it does for a line the person wrote.
- A profile with `fleet.json` and no `hedge.json` still works. Each `FLEET_`
  variable still works while its `HEDGE_` variable is unset. A `HEDGE_`
  variable that is set, even to an empty string, wins. Setup reuses a
  `fleet-profile` or `fleet-memory` repo.
- The repository is now `PostHog/hedge`, and the site is
  https://posthog.github.io/hedge/. GitHub sends the old repository address
  to the new one, so git, `get.sh` links and profiles that name
  `PostHog/fleet-engine` keep working. The old site address no longer works.

### The review budget

- Only a review that leads to fixes spends the review budget. The budget
  reads findings with the parser of `hedge proof gate` and
  `hedge proof respond`, so a finished review spends exactly when the gate
  asks for an answer to one of its findings. A review with only minor and nit
  findings spends nothing. A blocker, a major, a finding without a severity,
  and a `TESTS` item count, and an unfinished review counts. An item reads as
  minor or nit in the form `- file:line | minor | ...` and in the forms
  `1. minor, file:line: ...` and `1. nit: file:line ...`.
- Every item under the `TESTS:` heading of a review or a panel lens needs an
  answer and spends the review budget, even when it starts with `nit` or
  `minor`. Only a finding above that heading can read as minor or nit. A line
  that starts with `TESTS` opens the block, as before, so a nit below a prose
  line such as `TESTS pass under Bun.` needs an answer too.
- A prose finding that a review writes beside only the notes of its Anchor
  check is a finding. It gets the number after all other items, so an answer
  that an older hedge took still answers the same item.
- The ceiling never refuses a final read of a HEAD that `hedge proof gate`
  does not carry. It asks the gate's own question, from the same reviews,
  whatever `--base` names. A blocker or major that the read finds still
  counts, so the fixes rounds after it stop at the ceiling.
- A final read without `--agent` stops with "HEAD needs no final read" only
  when the gate carries HEAD across quiet commits, whatever `--base` names.
  Its advice names only the retries that can run: `--agent` only while the
  budget is left, and no retry while a review is unfinished.
- `hedge proof respond` takes a "known" answer only when the finished reviews
  that count reach the ceiling. A review counts when the gate asks for an
  answer to one of its items: a blocker, a major, a finding without a
  severity, or a TESTS item. An unfinished review does not count here, so a
  review that later finishes clean never leaves a "known" answer below the
  ceiling.
- A new review reads the PR's reviews and reserves its round while it holds
  a lock on the PR's reviews directory, and holds the lock only for these
  file reads and writes. Git, GitHub, and the arbiter run outside the lock.
  When another review started or ended meanwhile, it reserves nothing and
  asks you to run it again. This holds also when a dropped review comes back
  under the same name and phase: each reservation has its own id in
  `round.json`. A reservation or findings file that hedge cannot read for
  any reason other than a missing file stops the command with the read
  error, so the budget is never counted short. A review that
  finds the lock held stops and names the holder. This lock, a round lock,
  and a panel slot follow one rule: hedge takes over the lock when the
  process that holds it is gone. When ten takeovers of the budget lock or
  a round lock in a row stopped before they ended, the command stops, names
  the lock files, and gives the `rm` command that clears them. A stuck
  panel slot counts as taken. A
  final read takes the next free name in the reviews directory, so a
  leftover directory without `round.json` never blocks it.

## v0.1.0

The first public release. Fleet sets up T3 Code, Claude Code, Codex, and a set
of agent workflows on a Mac and on Linux devboxes. You pick the workflows as
packs, and your answers live in your own private profile repo.

### The command

- `get.sh` installs what Fleet needs, fetches the engine (`main`, or the tag
  or commit you give with `--ref`), puts `fleet` on the login PATH, and starts
  `fleet setup`. Running it again picks up where it stopped. It tries each
  download up to three times, and stops a download that cannot connect in 20
  seconds or stalls for a minute. It finds the newest T3 Code nightly in the
  releases feed, so the T3 Code installer does not use the GitHub API quota
  that shared networks run out of.
- `fleet setup` asks plain-language questions and offers a default wherever a
  pack has one. A devbox it sets up is listed in your profile, taken by
  your hub and linked from it, as `fleet devbox add` does; it refuses the
  same names. `--preset` starts from a preset's packs.
  `--non-interactive` asks nothing and lists what it still needs, such as
  sign-ins.
- `fleet apply` puts your profile's packs onto the machine. `fleet doctor`
  checks the machine against the same plan without changing it. `fleet update`
  moves the engine and your profile forward, then applies.
  When `fleet apply` installs T3 Code on Linux, it finds the nightly the same
  way `get.sh` does and runs the installer up to three times.
- `fleet packs`, `fleet settings`, and `fleet set` turn packs and workflows on
  and off and change their settings. `fleet devbox add` makes an SSH host one
  of your devboxes.

### Packs

- **Base** (always on): safety rules, the model table, T3 Code defaults written
  before its first start, linked machines, worktree cleanup, a disk guard, and
  nightly updates. A Claude Agent call that names no model is sent back with
  the model table. A prompt that asks to review a pull request, commit, or
  diff gets the table and a reminder that the reviewer is a worker that did
  not write the code. With Codex, a rules file lets Codex run these commands
  outside its sandbox without asking: Git fetches, pulls, and pushes; `gh`
  commands that read pull requests, runs, issues, and repos, and
  `gh pr create`, `edit`, and `ready`, which change pull requests; `bun` and
  `pnpm` installs, which run package scripts; `fleet heavy` and `fleet proof`,
  which run any command they are given; and `fleet doctor`,
  `fleet apply --dry-run`, and other `fleet` commands that read. A pack ships
  its own Codex rules with `codexRules`;
  Fleet writes them as `~/.codex/rules/fleet-<pack>.rules` and keeps a rules
  file you changed.
- **Pull requests** (on): every fix or feature ends as a proven, reviewed draft
  pull request. Ship words take it to merged.
- **Orchestration** (on): big work becomes a map of tickets that a conductor
  thread works through, and side work gets its own thread. The quality loop,
  the signal loop, and the PR digest are opt-in.
- **Communication** (on): agents write in your voice, give short updates, and
  share plans and previews as links.
- **Integrations** (off): Claude Code and Codex get the official GitHub,
  Context7, and Convex plugins, and with both AI plans Claude hands work to
  Codex through OpenAI's Codex plugin. Convex is opt-in. Fleet installs and
  removes only the plugins it installed, through each provider's own CLI, and
  `fleet doctor` lists each sign-in the plugins still need.
- **Memory** (off): agents on all your machines share what they learn through
  your own private memory repo.
- **Context library** (off): a prompt about a topic of your private notes repo
  gets links to its documents. `fleet context` searches the notes, saves a link
  as a condensed note, and keeps a catalog and topic hubs. Every machine pulls
  the repo every five minutes, keeps local changes, and fails the sync while
  they block it. With the MCP gateway, the hub serves a read-only
  `context_search` tool over the same notes.
- **Hub** (off): one always-on devbox manages the others. It signs in to your
  MCP servers once, keeps your devboxes linked, and watches their disks. The
  Slack bridge and the Google apps turn off the native Codex app they replace. A
  pack can run its own small MCP server in the gateway, with folders mounted
  read-only. The nightly Dream task and own-account balancing are opt-in.
  Own-account balancing routes Claude Code across several of your own
  subscriptions. It is off by default, and the page shows the Anthropic terms
  it touches.
- **Slack** (off): your own message, reaction, or mention in Slack starts a T3
  thread about it. With the Context library on, your `:brain:` reaction saves
  the thread and its canvases to your notes.
- **incident.io** (off): an agent that watches a risky change pages you, and
  only you, through your own incident.io alert source with `fleet page`. With
  a hub, the token lives on the hub and every other machine pages through it.

Team packs plug in as pack sources. The presets are Starter, Everyday, and
Everything.

### The site

[The Fleet site](https://posthog.github.io/hedge/) says what Fleet is
and offers two setups side by side: Mac only, and Mac plus a hub and a node.
Each setup has a switch for Pull requests, Orchestration, and Communication.
The Getting started prompt sits under the two setups and changes with each
choice. Copy it, or open it in T3 Code.

[The Packs page](https://posthog.github.io/hedge/packs/) shows every
pack, and each pack has its own page with its workflows, its cost, and its
settings. For a Fleet that already runs, select packs, and the page builds an
install prompt that adds them with `fleet packs --add`.

### Known gaps

CI proves the Linux first-run path on every pull request: a new Linux user
runs `get.sh` from the pull request's tree, then `fleet setup --non-interactive
--preset everyday` and `fleet doctor`, with a sandbox GitHub account. A second
user installs from the profile repo that setup made, the way a devbox does.
Setup leaves only the real sign-ins open, and `fleet doctor` finds nothing
open for either user.

These paths are built but not yet proved end to end, because each needs a
person's sign-in or machine: a run on a clean Mac user, real GitHub, Claude,
and ChatGPT sign-ins, `t3 up --connect`, and a live Coder devbox.
