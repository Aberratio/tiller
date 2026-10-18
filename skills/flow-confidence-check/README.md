# flow-confidence-check

An automated pre-merge check for your current branch. It answers one question: can this PR carry a
high-confidence verdict - does it solve the ticket, carry the required tests at the required level,
and is it safe?

It reviews spec alignment, test quality, security and obvious defects, re-checks every serious
finding in a second pass to remove false positives, and fixes what is safe to fix (validated with
scoped tests and lint). The output is a two-value verdict - `high-confidence` or `needs-review` - plus a paste-ready PR comment with a machine-readable
block.

Green is measured, never assumed: `high-confidence` needs CI check runs read from the forge for the
exact head SHA, or a local `verify-claim` re-run at that SHA when CI does not prove it. The only other
execution is fix verification: when the skill changes code, it proves the fix green before reporting.

## Install

From the repo root:

```bash
./install.sh flow-confidence-check
```

Or install every skill in the repo with `./install.sh all` - see the [main README](../README.md#setup).

Restart Claude Code (or start a new session). There is no per-repo configuration: on every run the
skill learns the repo from its own docs (CLAUDE.md, README, CONTRIBUTING). Update later with
`git pull`.

## When to run it

Once implementation on a branch is done, before or after opening the PR. Not during development - it
reviews the whole diff against the merge base.

Run it in a fresh session. The check refuses to grade work implemented in the same conversation,
because that context biases the judgment. The fresh session needs only the invocation and the spec
pointer (ticket id or spec file). You can override the guard, but the run is then stamped
`context: polluted` and can never earn `high-confidence`.

## How to invoke - real examples

Plain run (most common). It finds your ticket from the branch name via the tracker, resolves the
acceptance criteria, reviews, fixes blocker/high findings and reports:

```
/flow-confidence-check
```

Natural language works too:

```
confidence check this branch
is this ready for a PR?
review my branch against ABC-1234
```

Report-only, no fixes applied:

```
/flow-confidence-check fix=none
```

Fix everything it finds, not just blocker/high:

```
/flow-confidence-check fix=all
```

Hand it a spec explicitly (no ticket, or a thin one):

```
/flow-confidence-check docs/plans/my-feature-plan.md
/flow-confidence-check "AC1: bulk archive endpoint returns 202. AC2: archived items excluded from search."
```

With no ticket and no spec, it stops and asks for the change's intent. You can answer "no spec" and
it reviews without the spec-alignment dimension, but such a run can never be `high-confidence`.

## The verdict

`high-confidence` requires all of the following:

- every acceptance criterion implemented and covered by the required test type, or explicitly
  `out-of-reach` (not deliverable from this repo and handed to a named owning ticket)
- zero blocker, high and medium findings
- low findings within the size-scaled budget: `2 x ceil(reviewable_lines / 500)`, min 2
- no unresolved needs-user questions
- a real spec source and a clean (unpolluted) session
- every review dimension accounted for, by a finding or a stated "checked, nothing found"
- execution proven green at the head SHA (`ci-green` or `local-verified`)

Anything less is `needs-review`, with a `blocked-by` list naming every failed condition. There is no
numeric score, so the report can never say "94/100" while a criterion sits untested.

The PR comment embeds a machine-readable block (verdict, reviewed SHA, finding counts, AC counts,
spec source, execution evidence, verifier model, run mode) that a GitHub Action could parse to label
high-confidence PRs. The verdict is valid only for the exact commit SHA it was computed against.

If you build that Action: `issue_comment` fires on `edited` as well as `created`, so in-place updates
still trigger it, but it fires for any commenter, so check the comment author and confirm `sha:`
matches the PR's current head before trusting a verdict.

## What you get

- Terminal report: verdict and blocked-by, a per-AC coverage table (implemented? tested?), findings
  ranked blocker -> low
- Saved copy in `tmp/flow-confidence-check/`
- An offer to post a summary as a PR comment (never the PR description); re-runs edit that one
  comment, so the PR carries exactly one verdict
- On re-runs, fixed findings show as resolved and new ones are tagged `NEW`
- If the tree, spec, skill and merge base all match the last run, the previous verdict is re-stamped
  for the new commit SHA without dispatching any agent. Say "full run" to force a real re-review.

## Recommended workflow

1. Finish the ticket, commit everything.
2. Open a fresh session and run `/flow-confidence-check` (pass the ticket or spec if the branch name doesn't carry it).
3. Answer its questions (spec confirmation, dirty files) - it asks only when it cannot find the answer itself.
4. Fix or acknowledge what is left, and re-run if you changed code (any new commit voids the verdict).
5. Post the PR comment when you open the PR.

## Test-phase feedback wanted

The skill is in testing. Useful feedback:

- False positives that survived (findings you had to reject)
- Findings whose severity you disagreed with
- Verdicts that felt off (blocked for a bad reason, or high-confidence you wouldn't trust)
- Anything it should have caught but did not
- Rough wall-clock and token cost per run, if you notice it

If it flags something your team does on purpose, tell it "we do X on purpose". It offers to record a
review learning so the finding does not come back; learnings live in the repo and are shared via git.

## Design history

`docs/` holds the design specs: the v2 design (architecture, rubric, locked decisions) and the
MVP-improvements round (verify pass, severity floor, learnings, delta runs) with its verification
results. A later revision replaced the 0-100 score with the count-based verdict, narrowed code review
to a defect check, and added the context-pollution guard, the PR-comment block and measured green at
the head SHA. Read the docs before proposing changes.

Decisions recorded here so the skill text can stay rules-only:

- **No partial carry-forward on re-runs.** Phase 1b either re-stamps an unchanged run or reviews
  everything. Re-reviewing only changed files and inheriting the rest was rejected: Phase 6 already
  re-reviews its own fixes, AC coverage cannot be scoped per file, and findings are stochastic, so a
  full re-run can only add findings while a partial one freezes one sample. The exception is the fix
  loop: Phase 6 re-dispatches only the dimensions a fix touched, plus spec-alignment. Bringing
  carry-forward back needs measured evidence that full runs are too expensive.
- **Medium findings are verified.** The verdict requires zero medium, so medium most often decides it
  and has to survive being attacked. Relaxing the rubric so medium no longer blocks was rejected as
  loosening the gate for convenience. Verifying medium widens Phase 4 only, not the Phase 6 fix scope.
- **The verifier runs on a different model when one is offered.** A model refuting its own reasoning
  shares its blind spots. A smaller model is never used, because a wrong refutation silently kills a
  real finding.
- **The low budget scales with reviewed lines.** The old flat "at most 2" fit a ~400-500 line diff;
  the formula keeps that density, since a threshold a large diff cannot pass by construction says
  nothing about quality. The number of review agents is not a multiplier, or a run could buy headroom
  by fanning out wider. Counting only defect-category lows was rejected: the agent that writes a
  finding also picks its category, which would add a second escape hatch beside `out-of-reach`.
- **A combined agent must say what it checked.** On the small-diff path one agent covers all four
  dimensions. An empty findings list cannot tell "reviewed, clean" from "skipped", so each
  finding-free dimension needs a `checked` entry.

## Requirements

- Claude Code with subagent support (any recent version)
- Optional: a tracker MCP (for tracker kind `jira`, the Atlassian MCP) for automatic ticket resolution
  from branch names. You can always pass the spec by hand.
- The repo's dev tooling (e.g. a Docker dev stack) only when the auto-fix loop runs - review-only runs
  need nothing running
