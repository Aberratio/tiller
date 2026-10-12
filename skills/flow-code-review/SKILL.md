---
name: flow-code-review
description: Two-axis review of a change - Standards (this repo's documented conventions plus a Fowler smell baseline) and Spec (the ticket plus every agreement since) - reported side by side, never merged. Use when the user wants to review uncommitted work before committing, "review this diff", "review since main", "review my changes", "check this before I commit", a teammate's pushed branch, or a PR. Defaults to the uncommitted working tree.
user-invocable: true
---

# flow-code-review

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

Two axes, deliberately kept apart:

- **Standards** — does the code conform to this repo's documented conventions, plus a smell baseline that applies even when the repo documents nothing?
- **Spec** — does it faithfully implement the ticket *and* the decisions agreed with the owner since the ticket was written?

They run as parallel sub-agents so neither pollutes the other's context, and their findings are reported side by side and never merged. A change can pass one and fail the other: code that follows every convention while implementing the wrong thing, or code that does exactly what the ticket asked while breaking the project's conventions. Merging the reports is what lets one axis mask the other.

Its natural moment is **before the commit**, in the session that wrote the code. That is the opposite of flow-confidence-check, which grades a finished branch in a fresh session and owns verdicts, security, and the PR comment. This skill owns style, naming, architecture, and diff-vs-intent, and hands the code back for fixing.

## Step 0 — Locate and pin what you are reviewing

1. **Find the subject.** A workspace can hold several repos, and the user may name a branch rather than a repo. A teammate's branch may exist only on the remote: `git fetch origin`, then either check it out or review `origin/<branch>` in place.
2. **Pin the fixed point once** — whatever the user named, else the merge base with **the profile's main branch for this repo** (`origin/main` only if that is what the profile says): `git merge-base origin/<main> HEAD`. Resolve it (`git rev-parse`) and record the SHA. Every sub-agent must see the identical range.
3. **Branch on state, then pin the diff command.** This is where a review of uncommitted work silently reviews nothing:

   | State | Diff command | Why |
   |---|---|---|
   | Commits ahead of the fixed point, clean tree | `git diff <fixed>...HEAD` | three-dot compares against the merge base |
   | **Zero commits, dirty tree** (the common case) | `git add -N <new files>` then `git diff <fixed>` | three-dot returns *nothing* here, and even two-dot omits untracked files until they are intent-to-add |
   | Commits *and* uncommitted work | `git diff <fixed>` | two-dot covers both together |

   Also list the commits (`git log <fixed>..HEAD --oneline`) when there are any.
4. **Verify the diff is non-empty and complete** before dispatching anything: the file count in `git diff --stat` matches what `git status --short` shows. A brand-new untracked test file is the thing most often missing — name such files in the briefs with an instruction to Read them in full.
5. **Exclude and list.** Generated files, vendored code, lockfiles, data fixtures too large to read: exclude them from review *and* say in the report that you did. Never drop a file silently.

## Step 1 — Size the review before spending it

- **Behaviour change** → the full two-axis parallel run below.
- **Config or tooling one-liner** (a changed npm script, a deleted boilerplate test, a version bump) → dispatching two sub-agents costs more than reading it. Review inline against this checklist and say you took the short path: does the change actually **gate** what it claims to gate? Any escape hatch introduced (`|| true`, `continue-on-error`, `--passWithNoTests`)? Anything still referencing what you deleted? Any test now silently skipped?
- **Over ~1500 reviewable lines** → say that the size is itself a review smell and offer to review per top-level directory; record the degradation in the report.

## Step 2 — Assemble the Spec: the ticket **plus** every agreement since

The spec is almost never just the ticket. Collect, in order:

1. **The ticket** — via the ticket key in the branch name (the profile's `## commits` → `Ticket from branch:` pattern; fetched with the tracker role's `tracker.get`), a `#123` reference (`gh issue view`), or a spec/plan path the user passed.
2. **Spec addenda** — every decision agreed with the owner *after* the ticket was written: answers from the planning round, the plan the user approved, an ADR, a decision recorded in a Slack thread. List them explicitly in the brief, each labelled as agreed.

   This is load-bearing in both directions. Omit them and the Spec agent dutifully reports pre-agreed decisions as scope creep — pure triage noise. Include them and it verifies the diff against what was actually decided, and catches deviations from the *decisions* rather than only from the ticket.
3. **Artifacts the diff produces.** When the change generates a document, report, or inventory, name the produced file in the brief: the review must read the **artifact**, not only the generator. A generator whose logic reads clean can still emit ~60 rows that violate the ticket's constraint.
4. **Blocking tickets that are Done** — read what they actually shipped (a contract doc, a format spec); it usually constrains this change more precisely than the ticket text does.

Nothing found → say so and ask. Only the user may declare that there is no spec; if they do, the Spec axis reports "no spec available" and the report says the axis was skipped.

## Step 3 — Assemble the Standards sources, and pre-declare the deliberate deviations

- **Repo sources**: `CLAUDE.md`/`AGENTS.md` and what they link, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, testing conventions, ADRs, the domain glossary, and any accumulated review-learnings file.
- **The smell baseline** in `references/smell-baseline.md`, pasted into the brief in full — the sub-agent has no other access to it. It also carries the two rules that bind it: a documented repo standard always wins, and every baseline smell is a labelled judgement call.
- **Pre-declare every deliberate deviation — to BOTH axes.** List each choice made on purpose against a convention, with its one-line reason: a test importing the live corpus instead of a frozen fixture, a checked-in multi-MB fixture, an existing `data-testid` idiom, a temporary tarball dependency. Undeclared, an agent spends its strongest finding rediscovering a decision you already made. Declared, it grades the decision — which is far more useful ("intent honoured but fragile: stable path, version-revert trap").

  When an agent flags a deliberate choice anyway, the resolution is usually to **document the decision where the code lives** (a header comment saying why the test points at the live corpus), not to comply.
- **Pre-existing debt.** A smell the diff *extends* rather than introduces is labelled **"pre-existing — amplified by this change"** and routed to a separate tech-debt task. It is not billed to this change, and the fix is not quietly pulled into a focused diff.
- **Grade the prose the diff ships, as strictly as the code.** A plan, an ADR, a ground-truth label or a decision line inside the diff is a reviewable artifact, and on ABC-213 it was where **most** of the external reviewer's findings landed (7 of 14 comments from the profile's review-bot gate on PR #75, none of them raised by three agent review rounds): plan steps still describing the pre-re-land `client/` paths, a status table claiming staging verification that had never run, a step count that no longer matched the steps, an ADR consequence stated for all channel types when only body-frame ones were affected, and a corpus label saying "shipped" about a branch-only measurement. Three cheap questions per doc in the diff: does every path, count and status line still hold **after** whatever moved this branch (re-land, rebase, scope cut)? Is any verification marked done that nobody ran? Does the diff's own ADR/plan contradict the diff's code — and is the ADR named by full filename, per the repo convention? Docs are also where an author's optimism concentrates, which is exactly why an axis that only reads code misses it.

## Step 4 — Dispatch the axes in parallel

One message, one `Agent` call per axis, `general-purpose` sub-agents. The briefs are in `references/subagent-briefs.md` — read them now and use them as written; each already carries the diff command, the "do not use three-dot" warning where it applies, and its output contract.

- **Standards** and **Spec** always run (Spec unless the user declared no spec).
- **No `Agent` tool available** (this skill running inside a sub-agent, as every unattended run does): read both axes sequentially in this one context, and **declare it at the top of the report** — `Degraded run: both axes read by one context, no isolation between them.` The isolation is the mechanism, so a run without it is a weaker measurement, not an equivalent one; a reader who is not told treats it as the strong version. Never silently downgrade, and never skip an axis to compensate.
- **Works** runs when the user asks whether the change still works, or when the subject is someone else's branch: it executes the repo's **documented** check commands (discovered from CLAUDE.md/README/the CI workflow — the authority is what CI runs) and attributes every failure. A failure counts against the change only if it touches a file in the diff *and* reproduces with the declared tool versions; a stale `node_modules` makes lint and tests lie in both directions.

## Step 5 — Report side by side

Present `## Standards`, `## Spec`, and `## Works` (when it ran) as separate sections, each report verbatim or lightly cleaned. **Do not merge, dedupe across axes, or rerank** — the separation is the mechanism. Per axis: the finding count and the worst finding *within that axis*. No single winner across axes.

**Every finding opens with its location** — `path/to/file.ts:123`, or `:120-134` for a block, or several locations when the symptom recurs; a finding with no single site lists every site of the symptom rather than none. Two reasons, and the second is the expensive one: a reader cannot rule on a finding they have to go hunting for, and whoever fixes it — often a fresh agent that never saw this review's exploration — otherwise re-derives the whole change from zero. Measured on one unattended run: the fix pass cost 8.6 M context tokens against the implementation pass's 11.0 M, almost all of it rediscovery.

Then add what only you can add, having read both reports:

- **Your ruling per finding** — accept, or out of scope with the reason (pre-existing debt, a product decision, deliberate deviation already declared). An explicit ruling beats silence; silence reads as either agreement or an oversight.
- **A manual-QA section** when the work is heading for a human tester (a teammate's branch, a change QA will verify): the entry URL, the exact UI strings introduced, the edge cases the tests pin, so a tester can mirror them by hand.
- **Fix, then re-verify.** Findings you accept get fixed red→green in the same session; a fix that changes behaviour needs the test that proves it, not just a green suite.

## Done when

Both axes reported separately, unmerged ✓ every finding ruled on ✓ excluded files listed ✓ accepted findings fixed or explicitly deferred with a reason ✓

## What this skill does NOT do

- Issue a verdict, run a security pass, adversarially verify findings, auto-fix, or produce a PR comment (flow-confidence-check).
- Commit or open a PR (flow-create-commit, flow-create-pull-request).
- Run the test suite or lint, unless the **Works** axis was explicitly asked for — execution belongs to CI.
- Write tests (flow-tdd).
