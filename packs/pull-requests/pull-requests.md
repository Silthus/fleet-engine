# PR workflow

The workflow that `full-stop`, `full-send`, and `stamp-pr` follow.

## Steps

1. Build it test-first with the `tdd` skill. Pick the test seams yourself and name them in the pull request description. Before the pull request opens, run the design pass in `PANEL.md` of the `qa-swarm` skill and fix what holds.
2. Open the pull request as a draft, record the proofs it owes per `PROOF.md` of `qa-swarm` with `fleet proof require`, run them, and write the description with the `pr-description` skill, proof included.
3. Get at least one **review**, cast from the model table in `~/.agents/AGENTS.md`. Run it with `fleet proof review`, which runs that reviewer and records its findings. Answer them with `fleet proof respond`, and give later fixes a final read with `fleet proof review --scope final`. Check each finding against the code, fix what holds, and push.
4. Check every comment that other reviewers leave, bot or person, against the code. Fix what holds, or reply with the reason it does not. Resolve each bot thread you answered. When the same finding comes back after its fix, or after the number of review rounds in `skill-settings.md`, ask me.

Run `qa-swarm` in place of step 3 when I ask for it, when I ask for `full-send`, or when the diff touches a danger area of the `merge-risk` skill.

## Who reviews

With both AI plans, the review comes from the other family: Codex reviews code that Claude wrote, and Claude reviews code that Codex wrote. With one plan, the reviewer is a fresh session of the same provider that did not write the code. The model table names the model for each case.

## Done

The work is done when the **lane gate** is green locally, the repo's **full gate** is green on the pull request's head, `fleet proof gate` passes on the head, and every finding and review comment is fixed or rejected with a reason.

- The **lane gate** is the typecheck, lint, the repo's guard tests, and the tests of every module the diff changes. A repo's own lane gate command replaces this list.
- The **full gate** is the repo's CI checks. Push and keep working while it runs. In a repo without CI, it is the full test suite, run locally once on the final head.

## Merging

Merge with the merge command in `skill-settings.md`, unless the repo's own `AGENTS.md` names another.

## Specs and ready pull requests

- Before you publish a spec, run the spec pass in `SPEC.md` of `qa-swarm` on the draft.
- When I say a pull request is ready, start with the **First pass** of `babysit-pr`: answer and resolve every review-bot thread before anything else.
