# Severity, verdict, and report templates

## Severity (maps to reviewer action, not pipeline gates)

| Severity | Meaning |
|---|---|
| blocker | Must not merge: broken acceptance criterion, security hole |
| high | Fix before requesting review: missing required-level test coverage, likely bug |
| medium | Should fix, or explicitly note in the PR |
| low | Nit; mention only if it genuinely matters |

### Category -> severity mapping (floors; anchor agents against defaulting to medium)

- **Security** - exploitable injection / authz bypass / IDOR / committed secret: **blocker**. PII/PHI or tokens in logs, missing authz on a sensitive path, mass assignment of user input: **high** (blocker when actual PHI is exposed). Non-exploitable fragile pattern or rule violation (e.g. interpolation guarded by an allowlist): **medium/low**.
- **Test-coverage** - a stated acceptance criterion has no test: **blocker**. New logic or a mutating/side-effecting path with no test: **high**. Present-but-thin coverage: **medium**.
- **Correctness** - data loss/corruption or crash on a normal path: **blocker**. Likely bug on a real path (e.g. missing transaction around multiple writes): **high**. Edge-case-only: **medium**.

These are floors, not ceilings - justify any downward deviation in the finding.

## Verdict (there is NO numeric score)

Two values, computed mechanically from counts. No arithmetic, no weights, no judgment on top.

`high-confidence` requires ALL of:

| # | Condition |
|---|---|
| V1 | Every AC `covered` or `out-of-reach` - no `partial`, no `missing` |
| V2 | Zero blocker findings (post-verify) |
| V3 | Zero high findings (post-verify) |
| V4 | Zero medium findings (post-verify) |
| V5 | Low findings <= the low budget: `2 x ceil(reviewable_lines / 500)`, min 2 (SKILL.md Phase 5) |
| V6 | Zero unresolved `fix: needs-user` findings |
| V7 | `spec-source` != `none` |
| V8 | `context: clean` (pollution guard not overridden) |

Any condition failed → `needs-review`.
The `blocked-by` line lists EVERY failed condition in human terms, e.g.:
`blocked-by: AC3 test coverage partial (Type 1 checklist: no error path, no auth case) · 2 medium findings`

An AC-based block (V1) must cite the AC id and, for `partial`, the specific violated rubric checklist items.
An `out-of-reach` AC never appears in `blocked-by` - it does not block - but it is ALWAYS rendered in the AC table, the machine block and the PR comment, with its owning ticket. A verdict line may never read "all ACs covered" when one was `out-of-reach`; say "3 covered · 1 out of reach (ABC-227)".

Trend across runs and fix-loop rounds is expressed as finding-count deltas (`5 findings -> 2`), never as a number.

## Terminal report skeleton

Ticket id/link and the save directory come from discovery (`references/project-discovery.md`).

```markdown
# flow-confidence-check - <TICKET-ID> · <branch> · <YYYY-MM-DD HH:MM>
**Verdict: NEEDS-REVIEW** - blocked-by: AC2 test coverage missing · 1 high finding
Findings: 0 blocker / 1 high / 2 medium / 1 low · Low budget: 4 (1420 reviewable lines)
Diff: 14 files, +612/-88 (3 generated + 1 bloat CSV excluded) · Spec: ABC-1234 (jira) · Context: clean · SHA: a1b2c3d
Out of reach: AC4 -> ABC-227 (omit this line when no AC is out-of-reach)
Execution: deferred-to-ci · Mode: full
Fix loop: round 2 of max 3 · scope: high+ · fixed: F2, F3 · fix verification: green (3 files) · unresolved: none
Verifier killed: 2 wrong, 1 noise · kept on verifier failure: none
Suppressed by learnings: 1
Resolved since last run: F3, F7

## Acceptance criteria
| # | Criterion | Implementation | Test coverage |
|---|---|---|---|
| AC1 | <criterion> | met (file:line) | covered - spec/requests/...:12 |
| AC2 | <criterion> | met | MISSING (required: request spec) |
| AC4 | <criterion> | OUT OF REACH -> ABC-227 | OUT OF REACH -> ABC-227 |

An `out-of-reach` row carries its owning ticket in both cells and one line under the table: why no change in this repo can deliver it, with the O2 evidence reference.

## Findings (<n>)
### Blocker (<n>)
- **F1** `NEW` [test-coverage] <file:line>
  <one-sentence summary>
  -> <suggested action>
### High ... / Medium ... / Low ...

## Fix-loop history
- Round 1: 5 findings -> fixed F2 (high), F3 (high) · fix tests green
- Round 2: 3 findings -> nothing in scope left

## Excluded from review
<generated files> · <bloat files> · <uncommitted files if user chose exclude>

Saved: <discovered report dir>/<branch-slug>-<timestamp>.md
```

A `Mode: no-op` report is the previous run's report re-rendered verbatim with a new SHA and timestamp, plus one line naming the baseline it re-stamped (`Re-stamped from the run of <date> (<sha>) - tree, spec, skill and merge base all unchanged`).
Omit sections and header lines that do not apply (e.g. fix-loop history when scope was `none`; verifier/suppressed/resolved lines when their counts are zero; `NEW` tags and the resolved line on the first run for a branch).
Delta markers: `NEW` findings sort first within their severity band; carried-over findings keep their content unchanged.
The "Resolved since last run" line is the manual resolution-rate input: after 5-10 real runs, hand-count acted-on findings to tune the PR-comment floor and verifier aggressiveness.

## PR comment skeleton

Posted via `gh pr comment` after the user's go-ahead. Never touches the PR description.

The comment ALWAYS starts with the machine-readable block (HTML comment, invisible to readers, parseable by automation such as a future high-confidence GitHub Action).
Copy the field set exactly; automation matches on `flow-confidence-check` in the first line.

Severity floor for the human part: blocker and high findings render fully; medium/low collapse into one count line + a `<details>` block, one line per finding.

```markdown
<!-- flow-confidence-check
verdict: needs-review
sha: a1b2c3d4e5f6
findings: blocker=0 high=1 medium=2 low=1
low-budget: 4
ac: covered=3 partial=0 missing=1 out-of-reach=0
out-of-reach: -
spec: ABC-1234
spec-source: jira
execution: deferred-to-ci
context: clean
mode: full
blocked-by: AC2 test coverage missing, 1 high finding, 2 medium findings
-->
## 🔎 flow-confidence-check - Verdict: NEEDS-REVIEW
_Blocked by: AC2 test coverage missing · 1 high · 2 medium_ · findings 0/1/2/1 (blocker/high/medium/low)

**Summary for reviewers**
<2-4 sentences: what changed and why, in ticket terms, written for a cold reviewer.>

**Criteria coverage**
- AC1 ✅ implemented + tested (spec/requests/...:12)
- AC2 ⚠️ implemented, required request spec missing
- AC4 🎫 out of reach in this repo - owned by ABC-1234 (e.g. the gateway rejects before this repo's code runs, no reason document; fix lives in another repo)

The `🎫` line is never collapsed into the `<details>` block and never dropped: a reviewer must see, on the PR, which criterion this branch does not deliver and who owns it.

**Findings**
- F1 (high, test-coverage) - AC2 has no request spec

<details>
<summary>3 medium/low findings</summary>

- F4 (medium, defect-sanity) app/services/foo.rb:42 - <one line>
- F5 (medium, correctness) ... - <one line>
- F6 (low, ...) ... - <one line>

</details>

**Execution**: deferred to CI (this check runs no tests; gate on CI green)
**Auto-fixed this run**: F2, F3 (high) - fix tests green
**Left for human review**: F4 (medium) - <summary>

<details>
<summary>Run history</summary>

- 2026-07-27 a1b2c3d - needs-review - 0/1/2/1 (full)
- 2026-07-26 9f8e7d6 - needs-review - 0/3/2/1 (full)
</details>

_Posted by flow-confidence-check on <date> for commit a1b2c3d_
```

The comment is EDITED in place on every subsequent run (`scripts/post-pr-comment.sh` finds this skill's own comment by author + the machine block opening the body).
One PR carries exactly one machine block: a future auto-merge gate parsing `<!-- flow-confidence-check` must never have to choose between competing verdicts.
Run history is therefore the only trend record in the comment; omit the section on a first run.

`high-confidence` example header (same block shape, values differ):

```markdown
<!-- flow-confidence-check
verdict: high-confidence
sha: a1b2c3d4e5f6
findings: blocker=0 high=0 medium=0 low=1
low-budget: 4
ac: covered=3 partial=0 missing=0 out-of-reach=1
out-of-reach: AC4=ABC-227
spec: ABC-1234
spec-source: jira
execution: deferred-to-ci
context: clean
mode: full
blocked-by: -
-->
## 🔎 flow-confidence-check - Verdict: HIGH-CONFIDENCE
_3 of 4 ACs covered · AC4 out of reach, owned by ABC-227 · 0 blocker/high/medium · 1 low (budget 4)_ · valid for commit a1b2c3d only
```

Rules for the machine block:

- `verdict`: `high-confidence` | `needs-review`.
- `sha`: full SHA of the branch head the verdict was computed against. Any later commit voids the verdict.
- `spec-source`: `jira` | `file` | `author` | `conversation` | `none`.
- `context`: `clean` | `polluted (user-override)`.
- `mode`: `full` | `no-op`. `no-op` means Phase 1b proved nothing changed since the previous run and re-stamped that run's verdict against the current SHA - no agent was dispatched. A gate that wants a freshly computed verdict can require `mode: full`; a gate that trusts the Phase 1b equality checks can accept either.
- `low-budget`: the V5 allowance computed for this run (`2 x ceil(reviewable_lines / 500)`, min 2). A gate reading `low=N` needs the budget to know whether N passed.
- `out-of-reach`: `-` when none; otherwise a comma-separated `AC<n>=<TICKET>` list, one entry per `out-of-reach` AC, and the count in the `ac:` line must match it. An entry without a ticket id is invalid output - the AC was not eligible for the status (Phase 3, O1) and must have been left `partial`/`missing`.
- `blocked-by`: `-` when high-confidence; otherwise a comma-separated list covering every failed condition.
- Never hand-edit values to disagree with the terminal report - both render from the same computed state.
