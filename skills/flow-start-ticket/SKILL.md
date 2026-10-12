---
name: flow-start-ticket
description: Open the work on a ticket - fetch and sanity-check the ticket, create the correctly named branch from a fresh main, move the ticket to In Progress and assign it, and agree a short plan before any code is written. Use when the user says "start ABC-1234", "pick up the next ticket", "begin work on <ticket>", or names a ticket they want to implement.
user-invocable: true
---

# Start a ticket

## Step −1 — Resolve the project profile (before anything else)

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file; non-zero means stop
```

Read the profile it names. Every project-specific fact this skill needs — tracker kind and project key, main branch,
branch convention, worktree procedure, ledger path, merge authority, environments, test commands,
gates — comes from there and from nowhere else.

**No profile resolves → stop and say so.** Do not fall back to the project you saw last. Applying
one project's merge rule or test command to another is the failure this whole mechanism exists to
prevent.

Everything that should happen between "I'll take this ticket" and the first line of code, in one pass: ticket → branch → status → plan. The companion skills close the loop later (flow-create-commit for commits, flow-create-pull-request for the PR, flow-confidence-check for the pre-merge review).

## Step 0 — Discover repo conventions

The profile is the source of:

- the tracker (`## tracker`: kind, site) and the project key (`## identity`),
- the branch name convention (`## branching` → `Convention:`). With no convention declared there, the default is `<ticket>-<slug>` (e.g. `ABC-1234-accuracy-gate`) when a ticket exists, else `<type>/<slug>` (e.g. `fix/null-check-in-lookup`),
- the main branch and what merging to it means (`## repos`).

The repo's own docs (`CLAUDE.md`/`AGENTS.md`, anything they link for issue tracking) add the parent epic, if the repo pins one. If neither names a project and the user gave no ticket key, ask — never guess a project.

Tracker kind `none` → there is no ticket to fetch or move: the user names a spec file, Steps 1 and 4 are skipped, and the branch takes the `<type>/<slug>` form unless `## branching` says otherwise.

## Step 1 — Resolve the ticket

The calls below are tracker role ops from `$TILLER_HOME/config/tool-kinds.json`; the profile's tracker
Kind picks the tools, and `references/trackers/<kind>.md` gives each call's shape (`jira.md` for Kind `jira`).

- Ticket key given → `tracker.get` (fields: summary, description, status, assignee, parent, issuetype, priority).
- "the next ticket" / no key → `tracker.search` over the repo's project (and epic, if the repo pins one): unresolved Backlog/To Do issues, ordered by priority then rank. Show the top few (key, summary, status) and let the user pick. Never silently pick for them.

## Step 2 — Sanity-check before starting

Read the ticket the way the implementer will need it:

- **Status**: already In Progress or Done and assigned to someone else → stop and surface it; don't hijack work.
- **Blockers**: unresolved `is blocked by` links → surface them; starting anyway is the user's explicit call.
  - **Unattended, there is nobody to make that call, so resolve each link against the repo rather than against its tracker status.** A link is only a blocker if the surface this ticket needs is *missing from `origin/main`* — check for the function, export, route, table or endpoint by name. A ticket left In Progress whose work is already merged blocks nothing; a ticket marked Done whose branch never landed blocks everything. Status is a claim, `origin/main` is the oracle.
  - **A blocker that is real ends the run at Step 2** — no branch, no worktree, no tracker transition, so there is nothing to undo. Moving it to In Progress "because we are starting" misreports the board for whoever reads it next.
  - **Never start by stacking on the blocker's unmerged branch**, and never work around it by building a second copy of the thing that branch introduces — a competing access layer, a duplicated helper, a parallel route. Review will remove it, correctly, and the rebase after the blocker lands costs more than waiting. If the branch's own decision ledger forbids stacking, that is already settled and not yours to reopen.
- **Shape**: no recognisable objective or acceptance/success criteria → say what's missing and offer the flow-write-ticket skill (update mode) to fix the ticket *first*. A vague ticket started is a vague PR reviewed.
- **Off-state**: the work ships behind a flag, allow-list, pilot group, plan tier, or staged rollout — the tells are words like "feature-flagged", "PoC", "staging-only", "selected accounts", "test users". Settle now, before planning: what must a user *outside* the audience see, and in which environments will that be checked? If the ticket only describes the audience that gets the feature, name the gap and agree the off-state criterion with the user. It is the criterion nobody remembers to test, in the environment nobody opens.
- **Contracts you don't own**: the work consumes a field, endpoint, or flag from another team's service → write down what that service returns in *each* environment (dev / staging / production), and specifically what "feature off" looks like on the wire — an explicit empty value, or the field simply not being there. Get it confirmed by whoever owns that service rather than inferring it from a doc or a staging response; docs describe the environment their author was looking at.

One short confirmation covers this step ("<KEY>-1234 – <summary>; Backlog, unblocked, has ACs — start it?") unless something is actually wrong.

## Step 3 — Branch

```bash
git fetch origin
git checkout -b <branch> origin/<main>
```

- `<branch>` follows `## branching` → `Convention:`; with none declared, `<ticket>-<slug>`.
- Derive the slug from the ticket summary: 2–5 lowercase kebab words, no articles/filler.
- The profile declares a worktree procedure (`## branching` → `Worktrees:`, or `## worktree`) → create the branch through it instead of `git checkout -b`.
- Dirty working tree → ask: stash, commit elsewhere, or abort. Never carry unrelated changes onto the new branch.
- Branch for this key already exists → offer to reuse it instead of creating a duplicate.

## Step 4 — Update the tracker

- Assign the ticket to the user (`tracker.me` → account id) unless it's already theirs.
- Transition to In Progress: `tracker.transitions` → pick the transition whose target status is In Progress → `tracker.transition`. If no such transition exists from the current status, say so and leave the status alone — never force a different transition.

## Step 5 — Plan, briefly

Read the code the ticket touches (entry points, existing tests, the seams the change needs) and produce a **short** plan: 3–7 steps, each naming the area it touches, plus the test level each step lands at per the repo's testing conventions. Present it and get agreement before writing code.

- The user's process preferences win: if they work plan-mode-first or TDD-first, hand off there after agreement.
- Scope smell: the plan doesn't fit ~7 steps → the ticket is probably two tickets; say so and offer to split it (flow-write-ticket) before starting.
- Any plan touching a flag, allow-list, or availability condition carries one explicit step for verifying the **off** state in every environment the change reaches — not only the on state in the environment you develop against. Both states are the feature; only one of them gets exercised by accident.
- Flag a step that changes *how* availability is decided (swapping a hardcoded list for a value from an API, moving a check from client to server) as its own step, separate from the behaviour it enables. Those two arriving in one commit is how a gate change becomes invisible at review time.

## Done when

Branch created from fresh main ✓ ticket In Progress and assigned ✓ plan agreed ✓ — then implementation starts, and the closing bookends take over from there.

## What this skill does NOT do

- Write implementation code or tests (that's the work itself).
- Create or rewrite tickets (flow-write-ticket).
- Commit, open PRs, or review (flow-create-commit, flow-create-pull-request, flow-confidence-check).
