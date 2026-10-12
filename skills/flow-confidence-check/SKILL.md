---
name: flow-confidence-check
description: Confidence verdict for the current branch, run once all implementation work is done - before or after opening the PR. Use when the user says "confidence check", "preflight this", "review my branch", "pre-PR review", "is this ready for a PR", "check this against the ticket/spec", or finishes a ticket and wants a reviewer-ready summary. Judges the diff against the spec/acceptance criteria and outputs high-confidence or needs-review.
user-invocable: true
---

# flow-confidence-check

## Step −1 — Resolve the project profile (before anything else)

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file; non-zero means stop
```

Read the profile it names. Every project-specific fact this skill needs — tracker and project key, main branch,
branch convention, worktree procedure, ledger path, merge authority, environments, test commands,
gates — comes from there and from nowhere else.

**No profile resolves → stop and say so.** Do not fall back to the project you saw last. Applying
one project's merge rule or test command to another is the failure this whole mechanism exists to
prevent.

Pre-merge confidence verdict.
Answers: does this change solve the stated problem, carry the required tests, and is it safe - without the reviewer reading thousands of lines cold.
Output is a two-value verdict: `high-confidence` or `needs-review`.

The skill carries NO per-repo config.
`references/project-discovery.md` defines how to learn each repo from its own docs (CLAUDE.md + linked files, README, CONTRIBUTING) - run discovery FIRST, every run.
Missing essentials: ask, then offer to document the answer in the repo's CLAUDE.md.

## Invocation arguments

- Optional spec text or spec file path (overrides the cascade in Phase 1).
- Optional fix scope: `fix=none` (report-only) · `fix=high+` (blocker + high, **DEFAULT**) · `fix=medium+` · `fix=all`.
  Plain-language equivalents count ("don't fix anything", "fix everything", "fix medium and up").
- Optional `full` - skip the Phase 1b baseline check and review everything from scratch.
  Plain-language equivalents count ("full run", "ignore the previous run", "re-review everything").
  There is no opposite argument: the fast path is entered only when the skill can prove it is safe, and the user may always force MORE work, never less.

## Phase 0 - Context guard + scope the diff

1. **Context-pollution guard.** If this conversation contains implementation work on the branch under review (the session wrote or edited code that is now part of the diff), STOP.
   Tell the user to run the check in a fresh session, and print the exact invocation to carry over: the skill command plus the resolved spec pointer (ticket id, spec file path, or the AC text itself).
   Only the user may override. An override stamps the report and the machine block with `context: polluted (user-override)`, which automatically disqualifies `high-confidence`.
   The clean path - fresh session whose only input is the spec - stamps `context: clean`.
2. Run discovery per `references/project-discovery.md`. Fetch the default branch (best effort). Abort if on the default branch or 0 commits ahead of the merge base.
3. Pin the merge-base SHA once; reuse it everywhere (agents must all see the identical range). Record the branch head SHA - the verdict is valid only for this SHA.
4. List changed files; partition into reviewable vs excluded (generated + data-bloat globs from discovery). Excluded files count toward NEITHER review NOR the size calculation, and are listed in the report.
5. Dirty worktree: surface `git status --short`, ask include / exclude. Excluded uncommitted files become a report caveat.

## Phase 1 - Resolve the spec

Cascade (stop at first hit), each source stamped into the report and machine block as `spec-source`:

1. `file` - explicit argument: spec text or a local spec/plan file path.
2. `jira` - ticket via discovery's ticket cascade (Jira MCP for `ABC-123` branches, `gh issue view` for `#123` references).
3. `author` - the user explicitly states the acceptance criteria in this conversation (typed ACs count; vague intent does not).
4. `conversation` - ACs derived from conversation context or docs grep. This source is NEVER used silently: echo the derived `AC1..ACn` back and get explicit confirmation before any review dispatch. Unconfirmed = unresolved.
5. Nothing found: STOP and ask the user for the change's intent.

Never self-declare "no spec" - only the user can. User confirms none: skip the spec-alignment dimension, stamp `spec-source: none`. A `none` spec disqualifies `high-confidence`.
flow-confidence-check's own artifacts (prior reports, state files) are delta inputs only - they NEVER satisfy any step of this cascade.
Output: numbered acceptance criteria `AC1..ACn`.

## Phase 1b - Baseline check (no-op fast path)

Re-running on a branch that has not changed must not re-review it. The only thing that usually changed is the head SHA - because the engineer committed the previous run's auto-fixes - and the verdict is stamped against a SHA, so it needs a fresh stamp, not a fresh review.

Skip this phase entirely when the `full` argument was given, or when no state file exists for the branch.

Read `<repo>/tmp/flow-confidence-check/<branch-slug>.json` and take the no-op path only when **all four** hold:

| Check | Compare |
|---|---|
| Tree content | `scripts/tree-hash.sh` (same `--base` and `--exclude` globs as Phase 0) == stored `tree_hash` |
| Spec | sha256 of the resolved `AC1..ACn` text == stored `spec_hash`, and `spec-source` unchanged |
| Skill | `scripts/tree-hash.sh <skill-dir>/SKILL.md <skill-dir>/references/*.md` == stored `skill_hash` |
| Merge base | the SHA pinned in Phase 0 == stored `merge_base` |

Any mismatch, an unparseable or schema-mismatched state file, or a prior run recorded as degraded (`context: polluted`, `>1500 lines` fan-out, fix verification NOT RUN) → **full run**. Every check fails toward more work.

All four hold → dispatch NOTHING. Re-emit the stored verdict, findings, and AC table verbatim, re-stamped with the current head SHA, and jump straight to Final output (which rewrites the report file, updates the PR comment, and rewrites the state file with the new SHA). Stamp `mode: no-op`.

Announce the decision before acting - never ask. The user interrupts if it is wrong:

```
No changes since last run (2026-07-24). Verdict unchanged: high-confidence.
Re-stamped for commit a1b2c3d. Say "full run" to re-review from scratch.
```

```
Baseline discarded: spec changed since last run (AC hash differs). Full run.
```

This is the whole of the incremental design on purpose. Partial carry-forward - re-reviewing only changed files and inheriting findings for the rest - was considered and rejected: Phase 6 already re-reviews its own auto-fixes in-run, AC coverage is holistic and cannot be scoped per-file, and findings are stochastic samples rather than ground truth, so a full re-run can only ADD findings while a partial one freezes one sample. Do not reintroduce it without measured evidence that full runs are too expensive. (Such evidence exists for the *fix loop* and Phase 6 was narrowed accordingly - it re-dispatches only the dimensions a fix touched, plus spec-alignment. That does not extend to Phase 1b: a fresh invocation still reviews everything, because there the carry-forward would freeze one stochastic sample instead of re-sampling.)

## Phase 2 - Review (adaptive by reviewable line count)

- **< 300 lines**: dispatch ONE combined-dimensions subagent (prompt + contract in `references/subagent-prompts.md`). Never review inline in the main thread - its session context biases it toward its own work.
- **300-1500 lines**: read `references/subagent-prompts.md`; dispatch the four dimension agents (spec-alignment, defect-sanity, test-quality, security) in ONE message. Test-quality applies `references/test-quality-rubric.md` strictly.
- **> 1500 lines**: recommend splitting the PR first - that size is already a review smell. If the user proceeds anyway: restrict to source dirs or fan out per top-level directory (cap ~6 agents, all four dimensions folded into each prompt). Record the degradation in the report. Never silently sample.

The defect-sanity dimension is a shallow sanity check only (obvious defects: broken logic, data loss, N+1 on hot paths, dead code from this change).
Full code review is owned by the team's dedicated review tooling and by CI - this skill does not audit style, architecture, naming, or repo standards docs.

No tests or lint run in this phase or anywhere on the report path - execution is CI's job.
The report and machine block always stamp `execution: deferred-to-ci`.

## Phase 3 - Merge findings

1. Parse each agent's terminating json block (contract in subagent-prompts.md); fall back to prose on parse failure.
2. Dedup and cap per the merge rules; assign `F1..Fn`.
3. Join `ac_coverage` from spec-alignment (implementation) and test-quality (tests) - or split the combined agent's entries by their `aspect` field - into one per-AC table.
4. Apply the `out-of-reach` reclassification below to any AC the table shows as `partial` or `missing`.

### AC status `out-of-reach` (main thread only)

An AC can fail for two different reasons and the rubric must not confuse them: **the branch does not deliver the AC** (a defect of the branch - blocks, correctly), or **the AC cannot be delivered from this repo at all** (a defect of the ticket - blocks something the branch author has no power to change). The second one gets `out-of-reach`, which does NOT block the verdict.

Review agents NEVER emit this status - their contract stays `covered` / `partial` / `missing`. An isolated agent judging "this cannot be done here" is the cheapest possible escape hatch; only the main thread reclassifies, and only against evidence.

`out-of-reach` is legal only when ALL THREE hold:

| # | Requirement |
|---|---|
| O1 | **Owning ticket** - the id of an EXISTING ticket that carries the uncovered part. Verify it resolves (`tracker.get` / `gh issue view`); an id that does not fetch is not a ticket. This skill never files the ticket itself. |
| O2 | **Evidence** - a `file:line` or doc reference naming where the capability would have to live (the other service, repo, gateway, deployment) and why no change under this repo can produce it. Cited exactly like a finding's evidence. |
| O3 | **Reachable remainder is covered** - whatever part of the AC IS deliverable here is graded normally and is `covered`. An AC with a deliverable part still uncovered is `partial`, never `out-of-reach`. |

Any requirement unmet → the AC keeps the status the agents gave it (`partial` / `missing`) **and** the run raises one `fix: needs-user` finding: "AC<n> may be out of reach - needs an owning ticket before it can be reclassified". The verdict stays blocked. This is deliberate: without a named owner the state would be a way to retire inconvenient criteria by assertion.

Not `out-of-reach`: hard, large, "not in this sprint", "the author disagrees with the AC", "the reviewer thinks the AC is badly worded", or an AC deliverable here by a change nobody wants to make.

Every `out-of-reach` AC is visible in three places, always, never collapsed or omitted: the AC table (`out-of-reach -> <TICKET>`), the machine block (`ac: ... out-of-reach=<n>` plus one `out-of-reach:` mapping line), and the PR comment's criteria list.

## Phase 4 - Adversarial verify pass

Runs on BOTH paths (fan-out and combined-agent).

1. For each **blocker, high and medium** finding: dispatch one verifier subagent, all in ONE message (parallel). Low skips verification. Prompt + verdict contract in `references/subagent-prompts.md`. Verifier model: the session model, no tiering - a wrong refutation silently kills a real finding and nothing downstream catches it.
   - **Why medium is in scope**: the Phase 5 rubric requires *zero* medium for `high-confidence`, so medium is the severity that most often decides the verdict - and it was the only class carrying that weight without a single round of counter-argument. On `857af7d` four unverified mediums carried a `needs-review`. A severity a verdict rests on has to survive being attacked. The alternative - relaxing the rubric so medium no longer blocks - was rejected: it loosens the gate because the gate is inconvenient, not because it is wrong.
   - This widens Phase 4 only. The auto-fix loop in Phase 6 keeps its own severity scope; a confirmed medium does not become fixable by having been verified.
2. Apply verdicts mechanically:
   - `confirmed`: keep.
   - `refuted`: drop from findings; count into the report's kill summary line, split `wrong` vs `noise` by the verdict justification.
   - `downgraded`: apply the new severity, re-sort, note it on the finding.
   - Crash or no parseable verdict: KEEP the finding (fail open) and note it in the report - a broken verifier must not silently pass code.

## Phase 5 - Verdict

Computed mechanically from counts per `references/report-template.md` - no judgment, no numeric score.

`high-confidence` requires ALL of:

- Every AC `covered` or `out-of-reach` (any `partial` or `missing` fails; the blocked-by line cites the AC and the violated rubric checklist items). An `out-of-reach` AC never blocks - it is a defect of the ticket, not of the branch - but it is named in the report, the machine block and the PR comment, and it is legal only under O1-O3 in Phase 3.
- Zero blocker, zero high, zero medium findings after the verify pass.
- Low findings at or under the **low budget**: `2 x ceil(reviewable_lines / 500)`, minimum 2, where `reviewable_lines` is the Phase 0 reviewable line count (excluded files already excluded). 400 lines -> 2 · 1500 -> 6 · 3227 -> 14.
  The old flat "at most 2" was a density written for the ~400-500 line diff the rubric was designed on; the rule keeps that density instead of the constant, because the finding count scales with the surface reviewed while the constant does not, and a threshold that a large diff cannot pass by construction says nothing about the change's quality.
  The number of review agents is deliberately NOT a multiplier: the reviewed surface is the variable, the dispatch shape is a choice, and multiplying by agents would let a run buy itself headroom by fanning out wider.
  Counting only "defect-category" lows and excluding ticket-ownership findings was the alternative and is **rejected** - the same agent that writes the finding also assigns its category, so it would move the verdict from mechanical counting to a self-assigned classification, and it would create a second reclassification escape hatch beside `out-of-reach`. Do not add it on top of this rule; if it ever replaces it, this rule goes.
  Print the budget and the input in the report even when it passes: `Low budget: 14 (3227 reviewable lines)`.
- Zero unresolved `fix: needs-user` findings.
- `spec-source` is not `none`.
- `context: clean` (Phase 0 guard not overridden).
- Verdict stamped against the recorded head SHA; any commit after the run voids it.

Anything else → `needs-review`, with an explicit `blocked-by` list naming every failed condition.

Previous-run delta: if the state file (`<repo>/tmp/flow-confidence-check/<branch-slug>.json`) exists, match prior findings using the merge rules (same file, same category, |line delta| <= 3). Matched -> `carried-over`; unmatched new -> `NEW` (sorts first within its severity band); prior findings absent now -> list under "Resolved since last run". First run: no state file, no markers.
Persist: overwrite the state file. It is repo-local and per-branch - a worktree carries its own, and a missing one simply means a full run. Warn if `tmp/` is not git-ignored in this repo: a committed state file would hand a teammate a baseline they never earned.

```json
{
  "schema": 3,
  "run_date": "2026-07-27",
  "branch": "ABC-1234-thing",
  "head_sha": "<full sha the verdict was computed against>",
  "merge_base": "<sha pinned in Phase 0>",
  "tree_hash": "<scripts/tree-hash.sh over the review scope>",
  "skill_hash": "<scripts/tree-hash.sh over SKILL.md + references/*.md>",
  "spec_hash": "<sha256 of the resolved AC1..ACn text>",
  "spec_source": "jira",
  "spec_ref": "ABC-1234",
  "verdict": "needs-review",
  "degraded": false,
  "counts": { "blocker": 0, "high": 1, "medium": 2, "low": 1 },
  "low_budget": 6,
  "reviewable_lines": 1420,
  "ac": [
    { "id": "AC1", "implementation": "met", "tests": "covered" },
    { "id": "AC4", "implementation": "out-of-reach", "tests": "out-of-reach", "owner_ticket": "ABC-1234", "evidence": "e.g. docs/mvp-spec.md:§12 - the gateway rejects before this repo's code runs; fix lives in another repo" }
  ],
  "findings": [ { "id": "F1", "severity": "high", "category": "test-coverage", "file": "app/x.rb", "line": 42, "summary": "..." } ],
  "run_history": [ { "date": "2026-07-26", "sha": "9f8e7d6", "verdict": "needs-review", "mode": "full" } ]
}
```

`degraded: true` whenever the run was polluted, fan-out-degraded, or left fix verification unrun - Phase 1b refuses to build on it.
`run_history` keeps the last 10 entries, newest first, and feeds the PR comment's run-history section.
Prune while here: delete state files whose branch no longer exists locally (`git rev-parse --verify` fails) and any older than 30 days. Housekeeping - do not announce it.

## Phase 6 - Auto-fix loop

Skip when scope is `none` or no in-scope findings exist.

1. In-scope = findings at or above the scope's severity threshold, EXCLUDING `fix: needs-user` findings - those always escalate to the user, whatever the scope. Only verifier-confirmed findings reach this loop (refuted ones are already gone).
2. For each in-scope finding: double-check it is legitimate (cheap second guard after Phase 4), apply the smallest root-cause fix, never revert the author's intentional code.
3. **Fix verification** - the ONLY place this skill executes anything. Scope: exactly the files the fixes touched.
   - Tests: map the touched files to their test files via `scripts/changed-files.sh --mode tests` conventions (or discovery's documented test layout), run the discovered scoped test command on those files only. Failing fix-test: repair or revert the fix; never leave a red fix in the tree.
   - Lint: the discovered lint command on the touched files only.
   - Required wrapper/container not running: offer to start it; declined -> fixes stay applied but the report marks them "fix verification: NOT RUN".
4. Re-run Phase 2 on the updated tree (same pinned merge base, diff now includes the fixes), then Phases 3-5 - but re-dispatch **only the dimensions that raised a fixed finding, plus spec-alignment**, not all four. Spec-alignment always re-runs because AC coverage is holistic and cannot be scoped per-file; that is the same reason the Phase 1b carry-forward was rejected, and it is why this narrowing stops where it does. A dimension not re-dispatched keeps its round-1 report, and the Phase 5 verdict is told, by name, which dimensions did not see the final SHA - it may not award `high-confidence` on a pre-fix report for anything a fix could have touched.
5. Repeat until no in-scope findings remain, or the hard cap of **2 rounds**.
6. A finding that survives a fix attempt (same file + category reappears) is NOT re-fixed - report it "attempted, unresolved". Prevents oscillation.
7. Fixes stay uncommitted in the working tree; committing is the engineer's call. The verdict is computed on the post-fix tree; once the user commits, the machine block's SHA no longer matches and the check must be re-run for the verdict to count.

## Final output

1. Render the terminal report (skeleton in report-template.md), including fix-loop history and final verdict. Save it to the discovered report directory.
2. Re-read the PR-comment skeleton in `references/report-template.md` NOW - do not write the comment from memory. It MUST include the machine-readable block verbatim. Write the comment to a file in the report directory.
   PR exists: offer to post it via `scripts/post-pr-comment.sh <comment-file>` - ask first; the script validates the template markers and refuses non-conforming comments; it never edits the PR description.
   The script EDITS this skill's existing comment in place when it finds one, so the PR carries exactly one machine block and automation can never read a stale verdict; `--new` forces an additional comment. Editing does not notify reviewers - say so when the verdict changed.
   No PR yet: keep the comment file next to the saved report, suggest the `flow-create-pull-request` skill, offer to post right after creation.
3. List `needs-user` findings and anything unresolved as explicit next steps for the engineer.
4. Learnings write path (always ask, never silent): if the user rejected findings during the run as invalid or intentional, make ONE batch offer at the end to append them to the discovered learnings file - drafted entries shown first - and optionally suggest CLAUDE.md / AGENTS.md rule additions derived from them. A direct "remember this for reviews" appends right away (draft shown first). No learnings location yet: create `doc/review-learnings.md` and suggest a `## Review learnings` pointer section in the repo's root CLAUDE.md referencing it. Never append automatically from auto-fix acceptances.

## Decisions that are the owner's go to them as a choice, never as prose

Anything this run needs the owner to settle - scope, a deviation, a merge, a choice between two correct
roads - goes to them through **`AskUserQuestion`**, not as a paragraph in the report. Mutually
exclusive options, the recommendation first and marked `(Recommended)`, and for each one what we
gain, what we lose and the **cost of reversal**. The test before sending any summary: is there a
sentence here in which I settled something the owner could have settled differently? If yes, it is not a
sentence, it is an option. **When in doubt whose call it is, it is the owner's.**

Two exceptions, both of which park rather than ask: a **harness-level block** (a classifier or a
`permissions` denial) parks with the blocking rule named and is offered to no one; and a **session
with no interactive turn**, where the decision material is prepared and parked rather than the
question being skipped. The cascade before asking the owner is unchanged: the skill's own sources ->
`flow-resolver` -> the profile's `## owner proxy`.

## Hard rules

- READ-ONLY outside Phase 6; inside Phase 6 touch only what a fix requires.
- Never run tests or lint outside Phase 6 fix verification; never the full suite or repo-wide lint even there.
- Never auto-fix a finding that challenges product intent or spec interpretation.
- Never silently drop files from review - every exclusion is listed.
- Never emit `high-confidence` when any verdict condition fails - the conditions ARE the verdict; there is no judgment call on top.
- Test-files-only diff: run the test-quality dimension only; label the report "test-only change".
