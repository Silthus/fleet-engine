# PR workflow

The workflow that `full-stop`, `full-send`, and `stamp-pr` follow.

## Steps

1. Build it test-first with the `tdd` skill. Pick the test seams yourself and name them in the pull request description. Before the pull request opens, run the design pass in `PANEL.md` of the `qa-swarm` skill and fix what holds.
2. Open the pull request as a draft. Run the proofs it owes per `PROOF.md` of `qa-swarm`, and write the description with the `pr-description` skill, proof included.
3. Get at least one review round, as the **Rounds** of `qa-swarm` say. With the `fleet` CLI, `fleet proof` records the rounds, answers, and proofs. Without it, the `qa-swarm` ledger does. Check each finding against the code, fix what holds, and push.
4. Check every comment that other reviewers leave, bot or person, against the code. Fix what holds, or reply with the reason it does not. Resolve each bot thread you answered. When `fleet proof` or the review arbiter refuses another round, or the same finding comes back after its fix, ask me.

Run `qa-swarm` in place of step 3 when I ask for it, when I ask for `full-send`, or when the diff touches a danger area of the `merge-risk` skill.

Show me a comment before you post it as `pull-requests.commentApproval` says: `people` for comments that a person reads, `all` for every comment, `none` for no comment. This setting replaces the approval rule of `leaving-pr-comments`.

## Who reviews

Cast the reviewer from the review rows of the model table in `~/.agents/AGENTS.md`. The reviewer is always a session that did not write the code.

## Done

The work is done when the **lane gate** is green locally, the repo's **full gate** is green on the pull request's head, and every finding and review comment is fixed or rejected with a reason. With the `fleet` CLI, `fleet proof gate` also passes on the head.

- The **lane gate** is the typecheck, lint, the repo's guard tests, and the tests of every module the diff changes. A repo's own lane gate command replaces this list.
- The **full gate** is the required checks, or every check when the repo marks none required. Push and keep working while it runs. In a repo without CI, it is the full test suite, run locally once on the final head.

## Merging

Merge as the `rollout` skill says. When `pull-requests.mergeCommand` is set, use it in repos that name no other method.

## Specs and ready pull requests

- Before you publish a spec, run the spec pass in `SPEC.md` of `qa-swarm` on the draft.
- When I say a pull request is ready, start with the **First pass** of `babysit-pr`: answer and resolve every review-bot thread before anything else.
