# Setup note: Orchestration

Read this when the person picks the Orchestration pack.

**Maps** and **side threads** work with defaults. A map is one issue that
lists tickets; a conductor thread starts one worker thread per ticket. Maps
live in the issues of their `fleet-profile` repo unless they name another
repo with `--set orchestration.tracker=<owner/name>`.

Three workflows run by themselves on a schedule and start off:
`quality-loop`, `signal-loop`, and `pr-digest`. A preset can turn them on,
such as the author's. Each needs answers that setup asks as `--set` lines:

| Setting | What to ask |
| --- | --- |
| `orchestration.loopProject` | The folder of a repo they already opened in T3 Code, where the loops and the digest start threads. |
| `orchestration.qualityArea` | The paths in that repo the loops may change, such as `src/api`. |
| `orchestration.ledgerRepo` | A private repo for the loops' ledger. It records production numbers, so it stays private. |

On a first setup, recommend the loops off: they run at night without a
person, and they need a repo the person works in. Turn one on later with
`fleet packs --workflows quality-loop=on`.
