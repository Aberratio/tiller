# flow-resolve-conflicts

Resolve a stopped merge or rebase, or bring a conflicting PR up to date, by intent rather than by
hunk, and prove at the tip that nothing the conflict hid was lost.

Adapted from the generic five-step recipe (see the state, find the primary sources, resolve each
hunk, run the checks, finish). The five steps survive; field use added everything around them. The recurring lesson:
the conflicted hunks are the smallest part of the job — generated files, auto-merged damage, stale
installs and a check run at the wrong moment cost more than any marker.

## Project facts

| Fact | Profile section |
|---|---|
| rebase or merge, workspace git restrictions | `## branching` |
| whether a rebased pushed branch may be force-pushed | `## run policy` → `Force-push after rebase` |
| which files are generated, and the command that regenerates each | `## generated files` (new, optional) |
| how to reinstall dependencies | `## worktree setup` |
| the checks run at the tip | `## static checks`, `## test toolchain` |
| where a trade-off is recorded | `## decision ledger` |

## Relation to unattended runs

`lib/git/update-from-base.mjs` reports a conflict and never resolves it; the runner parks on the
base condition with the files named and dispatches no lane (tests in
`skills/flow-run-ticket/tests/run-ticket.test.mjs` assert this). Routing has no `conflict` lane;
`lib/contract/schemas/lane-conflict.json` is kept as the output shape for when one is added, and
this skill is the procedure it would follow.

## Rules earned in field use

Step number in parentheses.

- Always resolve; never `--abort` (top)
- PR or branch as the entry point; start the integration yourself (1)
- Backup ref; an in-progress operation you did not start has an owner (1)
- Batch: find the causing merge, own PRs only, one at a time (1)
- Containment before intent (`merge-base --is-ancestor`, comment-stripped diff) (2)
- Classify generated vs hand-written; take the base, regenerate, never hand-merge (3)
- A generated file with no known command is a question (3)
- Read why each side changed the region before any hunk (4)
- Same intent twice → take their side, keep the commit's remainder (4)
- Two implementations of one change → accepted side is the skeleton, fold in and re-verify (4)
- The other side moved the code → re-apply at the new home, re-read tests (4)
- Shared identifier → rename, full reference sweep, own commit (4)
- `add/add` in two formats → translate, allocate, count (4)
- Incompatible → goal wins, trade-off in the ledger, no invented behaviour (4)
- A replayed conflict is re-read for that commit's intent (4)
- Renamed/removed members on the other side → grep the whole branch diff; a removed member is a ledger decision (5)
- Scan auto-merged files for duplicated declarations (5)
- Reinstall before checks when a manifest changed; revert lockfile drift (5)
- Regenerate at the tip, its own commit (6.1)
- Checks at the tip, never per conflict; the typecheck is the detector for auto-merged damage (6.2)
- A red check is merge damage only if green on the base (6.2)
- Prove a preserved guard is still live by seeding it (6.3)
- Push, force only with lease per profile; confirm `MERGEABLE` (7)
- Merge commits keep git's default message (7)
- Name regions a sibling PR will re-conflict on (7)
- Report what the conflict surfaced (7)

### Not adopted

| Finding | Why |
|---|---|
| prefer merge over rebase on shared branches | the project decides in `## branching`; force-push safety is `## run policy` plus the lease |
| `gh pr ready`, `gh pr merge`, branch cleanup as teardown | merging belongs to `flow-create-pull-request` and `## merge authority`; this skill stops at a pushed, mergeable head |
| rebase siblings oldest-touching-the-least first | one observation, no evidence the order mattered; naming the shared region is what paid |
| do not `--autosquash` a regeneration into an old commit | covered by "regenerate at the tip, its own commit" |
| the ADR index's former-number note | a repo convention; the rule says to follow the repo's own convention |
| rerere replays only textual resolutions | an observation, not an action; covered by Step 5 |
| grep for an old contract version literal in prose | folded into the Step 5 grep for removed members |
| `awk` the top-level declarations | the tool is left open; the rule is the diff against both parents |
