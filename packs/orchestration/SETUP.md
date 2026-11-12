# Setup note: Orchestration

Read this when the person picks the Orchestration pack.

**Maps** and **side threads** work with defaults. A map is one issue that
lists tickets; a conductor thread starts one worker thread per ticket. Maps
live in the issues of their `fleet-profile` repo unless they name another
repo with `--set orchestration.tracker=<owner/name>`.

Three workflows run by themselves on a schedule and start off:
`quality-loop`, `signal-loop`, and `pr-digest`. Each runs once per fleet, on
the first node the profile lists, or on the hub when there is no node. They
never run on the Mac. Each needs answers:

| Setting | What to ask | Used by |
| --- | --- | --- |
| `orchestration.loopProject` | The folder of a repo they already opened in T3 Code on that machine, where the loops and the digest start threads. | All three |
| `orchestration.qualityArea` | The paths in that repo the loops may change, such as `src/api`. | The two loops |
| `orchestration.ledgerRepo` | A private repo for the loops' ledger. It records production numbers, so it stays private. | The two loops |

On a first setup, recommend them off: they run at night without a person,
and they need a node and a repo the person works in. A preset can turn them
on, such as `everything`. Setup on the Mac does not ask their answers, but the
node refuses the profile without them. So with such a preset, add
`--workflows quality-loop=off,signal-loop=off,pr-digest=off` to the setup
command, or, when they want the loops now, add the three answers as `--set`
lines. Once a node runs, turn one on with its answers:

```sh
fleet packs --workflows quality-loop=on --set orchestration.loopProject=<folder> --set orchestration.qualityArea=<paths> --set orchestration.ledgerRepo=<owner/name>
```
