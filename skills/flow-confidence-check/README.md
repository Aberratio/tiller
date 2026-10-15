# flow-confidence-check

Automated pre-merge confidence check for your current branch.
Answers one question: can this PR carry a high-confidence verdict - does it solve the ticket, carry the required tests at the required level, and is it safe?

Runs a multi-dimension review (spec alignment, test quality, security, plus a shallow defect sanity check), verifies every serious finding with an adversarial second pass to kill false positives, auto-fixes what is safe to fix (validating its own fixes with scoped tests + lint), and outputs a two-value verdict - `high-confidence` or `needs-review` - plus a paste-ready PR comment with a machine-readable block for automation.

Green is measured, never assumed: `high-confidence` needs CI check runs read from the forge for the exact head SHA, or a local `verify-claim` re-run at that SHA when CI does not prove it.
The only other execution is fix verification: when it changes code itself, it proves the fix green before reporting.

## Install

From the repo root:

```bash
./install.sh flow-confidence-check
```

Or install every skill in the repo with `./install.sh all` - see the [main README](../README.md#setup).

Restart Claude Code (or start a new session). Done - no configuration.
The skill carries no per-repo config; it learns each repo from its own docs (CLAUDE.md, README, CONTRIBUTING) on every run.
Update later with `git pull`.

## When to run it

Once implementation work on a branch is done - before or after opening the PR.
Not during development (it reviews the whole diff against the merge base).

**Run it in a fresh session.**
The check refuses to grade work implemented in the same conversation - the implementation context biases the judgment.
Ideal input for the fresh session: just the invocation plus the spec pointer (ticket id or spec file).
You can override the guard, but an overridden run is stamped `context: polluted` and can never earn `high-confidence`.

## How to invoke - real examples

Plain run (most common). Finds your ticket from the branch name via the tracker, resolves acceptance criteria, reviews, fixes blocker/high findings, reports:

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

Hand it a spec explicitly (no ticket, or ticket is thin):

```
/flow-confidence-check docs/plans/my-feature-plan.md
/flow-confidence-check "AC1: bulk archive endpoint returns 202. AC2: archived items excluded from search."
```

No ticket and no spec? It will stop and ask you for the change's intent - that is deliberate.
You can answer "no spec" and it reviews without the spec-alignment dimension, but a no-spec run can never be `high-confidence`.

## The verdict

`high-confidence` means ALL of: every acceptance criterion implemented AND covered by the required test type (or explicitly `out-of-reach` - not deliverable from this repo and handed to a named owning ticket), zero blocker/high/medium findings, low findings within the size-scaled low budget (`2 x ceil(reviewable_lines / 500)`, min 2), no unresolved needs-user questions, a real spec source, a clean (unpolluted) session, every review dimension accounted for (a finding or a stated "checked, nothing found"), and execution proven green at the head SHA (`ci-green` or `local-verified`).
Anything less is `needs-review`, with an explicit `blocked-by` list naming every failed condition.

There is no numeric score - the verdict conditions are the whole mechanism, so the report can never say "94/100" while an acceptance criterion sits untested.

The PR comment embeds a machine-readable block (verdict, reviewed SHA, finding counts, AC counts, spec source, execution evidence, verifier model, run mode).
A future GitHub Action can parse it to label high-confidence PRs - the verdict is only valid for the exact commit SHA it was computed against.
Because re-runs edit that one comment, such an Action never has to pick between competing verdict blocks on the same PR.

If you do build that Action: `issue_comment` fires on `edited` as well as `created`, so in-place updates still trigger it - but it fires for **any** commenter, so the workflow must check the comment author and confirm `sha:` matches the PR's current head before trusting a verdict.

## What you get

- Terminal report: verdict + blocked-by, per-AC coverage table (implemented? tested?), findings ranked blocker -> low
- Saved copy in `tmp/flow-confidence-check/`
- Offer to post a reviewer-friendly summary as a PR comment (never touches your PR description) - re-runs EDIT that same comment instead of stacking new ones, so the PR always carries exactly one verdict
- Re-runs on the same branch show fixed findings as resolved and tag new ones `NEW`
- Re-running an unchanged branch costs nothing: if the tree, the spec, the skill and the merge base are all identical to the last run, it re-stamps the previous verdict for the new commit SHA without dispatching a single agent. Say "full run" to force a real re-review.

## Recommended workflow

1. Finish the ticket, commit everything.
2. Open a FRESH session, run `/flow-confidence-check` (pass the ticket or spec if the branch name doesn't carry it).
3. Answer its questions (spec confirmation, dirty files) honestly - it asks only when it cannot self-serve.
4. Fix or acknowledge what is left, re-run if you changed code (the verdict is void after any new commit).
5. Post the PR comment when you open the PR.

## Test-phase feedback wanted

You are one of the early testers. Please share:

- False positives that survived (findings you had to reject)
- Findings you disagreed with the severity of
- Verdicts that felt off (blocked for a bad reason / high-confidence you wouldn't trust)
- Anything it should have caught but did not
- Rough wall-clock + token cost per run if you notice it

If it flags something your team does on purpose, tell it "we do X on purpose" - it will offer to record a review learning so the finding never comes back for anyone (learnings live in the repo, shared via git).

## Design history

`docs/` holds the design specs behind the skill - the v2 design (architecture, rubric, locked decisions) and the MVP-improvements round (verify pass, severity floor, learnings, delta runs) with its verification results.
A later revision replaced the 0-100 score with the count-based verdict, narrowed code review to a defect sanity check, added the context-pollution guard, and added the machine-readable PR-comment block.
Execution was first deferred to CI wholesale; that let a verdict ride on an assumed green, so `high-confidence` now requires green measured at the head SHA (CI check runs, else a local `verify-claim` re-run).
Read the docs before proposing changes; they record what was already decided and why.

Decisions recorded here so the skill text can stay rules-only:

- **No partial carry-forward on re-runs.** Phase 1b either re-stamps an unchanged run or reviews everything. Re-reviewing only changed files and inheriting findings for the rest was rejected: Phase 6 already re-reviews its own fixes in-run, AC coverage is holistic and cannot be scoped per file, and findings are stochastic samples, so a full re-run can only add findings while a partial one freezes one sample. The fix loop is the measured exception: Phase 6 re-dispatches only the dimensions a fix touched, plus spec-alignment. Reintroducing carry-forward for fresh invocations needs measured evidence that full runs are too expensive.
- **Medium findings are verified.** The verdict requires zero medium, so medium is the severity that most often decides it, and a severity a verdict rests on has to survive being attacked. Relaxing the rubric so medium no longer blocks was rejected: it loosens the gate because the gate is inconvenient, not because it is wrong. Verifying medium widens Phase 4 only; it does not widen the Phase 6 fix scope.
- **The verifier runs on a different model when one is offered.** A model refuting its own reasoning shares its blind spots; a smaller model is never used, because a wrong refutation silently kills a real finding.
- **The low budget scales with reviewed lines.** The old flat "at most 2" was a density written for a ~400-500 line diff; the rule keeps that density, because the finding count scales with the surface reviewed and a threshold a large diff cannot pass by construction says nothing about quality. The number of review agents is not a multiplier: the dispatch shape is a choice, and multiplying by agents would let a run buy headroom by fanning out wider. Counting only defect-category lows was rejected: the agent that writes a finding also assigns its category, so the verdict would rest on a self-assigned classification and gain a second reclassification escape hatch beside `out-of-reach`.
- **A combined agent must say what it checked.** On the small-diff path one agent covers all four dimensions; an empty findings list cannot tell "reviewed, clean" from "skipped", so each finding-free dimension needs a `checked` entry.

## Requirements

- Claude Code with subagent support (any recent version)
- A tracker MCP connected (for tracker kind `jira`, the Atlassian MCP) = automatic ticket resolution from branch names (optional; you can always pass the spec by hand)
- The repo's dev tooling (e.g. Docker dev stack) only when the auto-fix loop runs - review-only runs need nothing running
