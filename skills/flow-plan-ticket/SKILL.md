---
name: flow-plan-ticket
description: Turn one already-specified ticket into an implementation plan - verify the ticket's premise against the repo, branch on ticket kind, name the seams flow-tdd inherits, and surface the steps nobody on the ticket has permission to take. Use when the user says "analyse and plan ABC-1234", "plan the implementation", "what's the plan for this ticket", or asks for a plan rather than code, and when a ticket is already spec-shaped so there is nothing left to specify.
user-invocable: true
---

# flow-plan-ticket

**Step −1 — resolve the profile.** Follow `$TILLER_HOME/skills/_shared/resolve-profile.md` exactly; a skill that resolves no profile stops here.

The step between "this ticket is mine" and the first test, for work that arrives already written as a spec: objective, success criteria, constraints, non-goals. Nothing is left to specify — what is left is to find out whether the ticket is still true, what it touches, and which parts of it nobody involved is allowed to do.

A ticket is a **claim about the codebase on the day it was written**, not a description of it today. Much of this skill is the discipline of checking that claim before planning on top of it.

`references/ticket-kinds.md` carries the playbook per kind — a ticket reaches exactly one.
`references/hand-offs.md` is for the step on the critical path that you, or the assignee, are not permitted to take.

## Step 0 — Discover the repo's conventions

Read the repo's own docs (`CLAUDE.md`/`AGENTS.md` and what they link, README, CONTRIBUTING, testing docs, ADRs in the area the ticket touches). Capture:

- the **test levels** this repo names (unit / request / component / e2e / replay) — the plan's steps are written in that vocabulary, because flow-tdd executes it,
- the **gates** CI runs (typecheck, lint, formatter, complexity cops), so a step that will have to satisfy one says so up front,
- where a plan lives in this repo — a `docs/plans/` or equivalent; default `docs/plans/<KEY>-<slug>.md`. **A caller that names a path for the plan overrides this**: the plan goes there and nowhere else, never also into the worktree, and is never committed — a plan committed with the change counts toward who may merge it,
- the domain vocabulary, so the plan reads in the project's own language.

This skill carries no per-repo config. Something essential is undocumented → ask.

## Step 1 — Assemble the ticket's real inputs

The ticket text is the smallest of its inputs.

- **The ticket, its parent/epic, and every linked ticket** in both directions.
- **What the resolved blockers shipped, not what they promised.** Open the artefacts a Done blocker actually produced — the format doc, the module, the endpoint, the migration. This is repeatedly the highest-value single step of planning: the ticket text alone misses the contracts its own criteria have to obey.
- **Every referenced doc, opened.** A reference that is blank, dead, or written about a different environment is a finding, not a footnote: it means the contract does not exist yet, so defining it becomes a step in the plan instead of a lookup during implementation.

**Complete when** every link on the ticket has been opened and is either summarised in one line or recorded as dead.

## Step 2 — Verify the premise

Check each claim the ticket rests on against the repo as it is now: the dependency exists and is published, the file still has that shape, the measured number still reproduces, the state it describes is the current state.

A false premise found here costs minutes. Found during implementation it costs the plan, and the ticket usually gets closed as complete over work that was never possible.

When a premise is false, **the corrected ticket is the plan's first deliverable**: say which acceptance criteria change, and hand the rewrite to flow-write-ticket.

**Complete when** every factual claim the plan depends on is either confirmed against the repo or written down as a correction.

## Step 3 — Classify the ticket kind

The kind decides what a *step* in this plan even is. Exactly one fits; the playbooks are in `references/ticket-kinds.md`.

| kind | the plan's spine | what proves a step done |
|---|---|---|
| **code** | seams → red→green slices | a test that failed for the ticket's reason, then passes |
| **data / ops** | a protocol a human executes | a definition-of-done checklist per artefact or session |
| **pipeline / tooling** | the CI job is the unit under test | a run URL showing the job red, then the same job green |
| **bug, already diagnosed** | the diagnostic probe becomes the first red | the reported scenario reproduced, then fixed |

A ticket that genuinely spans two kinds is usually two tickets, or one kind plus a hand-off (Step 5). Name which, and say so before planning both.

## Step 4 — Map onto the codebase, and name the seams

Read the code the ticket touches and state **what already exists** — the module, the pattern, the test file, the CLI the change extends. A plan that reinvents what the repo already has is how a codebase grows a second way of doing everything. Fan out parallel exploration when the ticket crosses repos.

For a code ticket the map's output is the **seam table**, in the columns flow-tdd restates verbatim:

| seam | test level | loop mode | deliberately not tested here |
|---|---|---|---|

The last column is the load-bearing one: it records the negatives — no e2e for a read-only listing, the component's React internals, the 1200-line page's render body — so review reads a decision instead of a hole. Non-code kinds emit their protocol or job definition here instead.

Proposing the seams at plan time and confirming them once is cheaper than an interactive checkpoint mid-loop, which is why flow-tdd inherits this table rather than negotiating it.

## Step 5 — Walk the critical path for hand-offs

Some of the ticket is not yours to do. Find those steps while they are still a plan and not a half-finished branch. Two triggers:

- **Irreversible** — a point of no return: a publish to a shared registry, a pushed tag, a data migration, anything immutable once done.
- **Out-of-band** — needs a permission, credential, or system you do not hold: a repo setting, a CI context, a secret, an admin-only merge rule.

Probe rather than assume. `gh api repos/<org>/<repo> --jq .permissions` answers "can the assignee even do this" in one call, and a credential someone handed you gets verified standalone *before* the plan builds on it. `references/hand-offs.md` has the rest, including the consumability case — a dependency that is not installable yet is work, and it is step 1 of the plan rather than an assumption.

An acceptance criterion nobody on this ticket can execute becomes an explicit hand-off task with a named owner and a fallback — land the executable half, raise the follow-up — instead of a criterion that gets quietly ticked. Git steps (commit, push, tag, PR) are the human's, or delegated to flow-create-commit / flow-create-pull-request; the plan marks them so.

**Ask what the seam table did to merge authority, and ask it against the repo's own path list.** A hand-off is usually a step you can see in the plan; this one is a *consequence* of Step 4 and is invisible in the steps. Where a seam lands can decide who may click merge — a repo whose merge rules are path-scoped turns "put the pure function in the core" into "this branch now needs a human signature", and the plan that does not say so discovers it at merge time, which is the expensive end. So: take the paths the seam table implies, hold them against the profile's `## merge authority` table (`facts.mergeAuthority`) — read from the profile and never from memory — and when a seam buys a signature, **record the trade in the decision, not only in the hand-off table** — the alternative seam that would not have bought it is what makes it a decision the owner can overturn. Never generalise from one path named in a prompt to "therefore the sibling directory is exempt".

**Complete when** every step is marked agent-executable or hand-off, each hand-off names its owner, its exact command, and its fallback, and the paths the seam table implies have been held against the repo's merge rule.

## Step 6 — Settle the open decisions

A spec-shaped ticket still leaves decisions the implementer would otherwise make silently and alone. Surface them here, in the mode the session allows:

- **Interactive** — ask them as concrete options with the consequence of each, and only the ones that change the plan.
- **Autonomous** — decide each with a stated default rather than blocking.

Either way the plan records them identically, as **decisions taken, overridable**: one line each, the choice, and the alternative it beat. That section is not a courtesy — Step 7 copies it into the decision ledger the review skills read, and a decision missing from it comes back later reported as scope creep.

Do the authoritative lookups now — real versions, licences, hashes, field names, from whoever owns them. A placeholder in a plan is a fact the implementer re-derives under time pressure.

**Complete when** no decision in the plan is still phrased as a question, and none is a placeholder.

## Step 7 — Emit the plan

The plan is a document with these parts, in this order:

1. **What this ticket actually is** — one paragraph, plus any correction Step 2 produced.
2. **Decisions taken, overridable** — Step 6's list.
3. **The spine** — the seam table (code), the protocol and its definition of done (data/ops), or the job and its evidence (pipeline).
4. **Steps** — 3–7 of them, each naming the area it touches, its test level, and its agent-or-hand-off marker.
5. **Hand-offs and gates** — owner, exact command, fallback, from Step 5.
6. **What no test level reaches** — in two classes: needs a human or a physical device; and non-behavioural (a document, a version policy, a naming convention, something "agreed with" another team). Both are real work, and the second is the one that gets ticked silently because writing it feels like progress.
7. **Traceability** — every acceptance criterion mapped to the step, hand-off, or verification item that satisfies it.

Write it to the caller's path when one was named, else to the path from Step 0 when the repo has one or the plan runs past ~7 steps; otherwise present it in the session. Say where it ended up either way, because the next two skills read it.

Then copy part 2 into the branch's **decision ledger**, one line per decision, in the shape `flow-decision-ledger` defines — a plan decision is tagged `spec`, one that also goes against a repo convention `both`. Autonomous-mode defaults end in `self` and stay overridable. The plan holds the reasoning; the ledger is what the reviews read on their own, so nobody pastes these decisions into a review brief by hand. Implementation appends to the same file as further deviations are taken.

Invoked straight off a ticket key, both files are due before a branch exists. Write them anyway, **untracked on `main`** — an untracked file survives `git checkout -b`, so both travel onto the branch flow-start-ticket creates and are committed there with the change. Do not commit either to `main`, and do not defer writing them until the branch exists: the reasoning is freshest now, and the ledger's whole point is that a review reads it without being told.

Scope smell: the steps do not fit in ~7 → it is two tickets. Say so and offer the split (flow-write-ticket) before implementation starts.

**Complete when** every acceptance criterion appears in part 7 exactly once.

## Done when

Premise verified or corrected ✓ kind named ✓ seams stated in the columns flow-tdd inherits ✓ every step marked agent-executable or hand-off ✓ the seam table's paths held against the repo's merge rule, and a signature it buys recorded as a trade in the decision ✓ decisions recorded as taken-and-overridable rather than left as questions, and each one a line in the ledger ✓ every acceptance criterion traced to a step, a hand-off, or a named human-verification item ✓

## What this skill does NOT do

- Fetch the ticket, create the branch, or move it to In Progress (flow-start-ticket — this skill is its plan step, in full).
- Write or rewrite the ticket (flow-write-ticket), even when Step 2 falsifies its premise: this skill produces the correction, that skill applies it.
- Find a bug's root cause (flow-diagnose-bug runs first; this skill plans what the diagnosis found — its "plan" deliverable exits straight into here, carrying the cause, the numbers and an unwritten regression test).
- Write tests or implementation (flow-tdd inherits the seam table from here).
- Review, commit, or open a PR (flow-code-review, flow-create-commit, flow-create-pull-request).
- Explore what to build when there is no ticket yet (flow-brainstorm).
