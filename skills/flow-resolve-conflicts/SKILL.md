---
name: flow-resolve-conflicts
description: Use when a git merge or rebase stopped on conflicts, when a PR reports CONFLICTING or DIRTY, when a branch must be brought up to date with its base and may conflict, when asked to "fix my open PRs" after something merged, or when a run parked on the base condition with conflicting files named. Also the procedure a `conflict` lane follows.
user-invocable: true
---

# Resolve merge conflicts

## Step −1 — Resolve the project profile

Read `$TILLER_HOME/skills/_shared/resolve-profile.md` and follow it; no profile resolves → stop.

Read from it: `## branching` (rebase or merge, workspace git restrictions), `## run policy`
(`Force-push after rebase`), `## generated files`, `## worktree setup`, `## static checks`,
`## test toolchain`, `## decision ledger`. **No profile resolves → stop and say so.**

**Always resolve; never `--abort`.** A resolution that needs a decision nobody here may take is a
question (Step 7), with every other file still resolved.

## Step 1 — Establish the state

- Given a PR or a branch rather than a stopped operation: `gh pr view --json headRefName,baseRefName,mergeable`,
  check out the head, and start the integration the profile names (`git rebase origin/<base>` or
  `git merge origin/<base>`).
- Before starting, `git branch backup/<branch>-pre-<method>-<date>`. A ref keeps commits, not an
  in-progress rebase or unstaged resolutions.
- An operation already in progress (`$(git rev-parse --git-dir)/rebase-merge`, `rebase-apply`,
  `MERGE_HEAD`) that you did not start belongs to someone else: find its owner before touching it.
- Many PRs at once: find the merge that caused the conflicts (`gh pr list --state merged`), keep
  only PRs this session owns, and take them one at a time.

Done when: the conflicted file list is known (`git diff --name-only --diff-filter=U`) and so is
the commit on the other side that caused each one.

## Step 2 — Containment before intent

For each commit touching a conflicted file, `git merge-base --is-ancestor <commit> <other-side>`.
A commit the other side already contains needs no resolution. When one side is a rebased copy of
work the other already merged, expect the residue to be comment-only; confirm with a
comment-stripped diff before opening hunks.

## Step 3 — Classify every conflicted file

- **Generated** — matches a `## generated files` glob. Take the base's version (`--ours` during a
  rebase, `--theirs` during a merge), run the row's Command, stage the result. Never hand-merge its
  hunks. A row whose Command is `n/a` is a question.
- **Announces itself as generated** (a lockfile, `*.gen.*`, a "do not edit" header) but matches no
  glob — a question, never a guessed command.
- **Hand-written** — everything else: Step 4.

## Step 4 — Resolve each hand-written conflict by intent

Read why each side changed the region: `git log <base>..<other> -- <file>`, the commit messages,
the PR, the ticket. Then pick the shape that fits:

| The conflict is | Resolution |
|---|---|
| two compatible intents | keep both |
| the other side already made this change (the tell: the conflict sits in the exact lines your commit is named after) | take their side wholesale; your commit keeps whatever remains, even only its comment |
| two implementations of one change (a re-run, a cherry-pick, a redone PR) | the side already merged or reviewed is the skeleton; list what only the other side adds, re-verify each item at the new tip, fold it in; the code settles factual disagreements |
| the other side moved, extracted or renamed this code (`--diff-filter=A` shows new sibling files) | re-apply your addition at the code's new home, delete the duplicated half, re-read your tests for renamed or now-ambiguous identifiers |
| both sides claimed the same identifier (an index row, a migration number, a numbered document) | one side takes the next free identifier: rename, sweep every reference including source comments and the artifact's own title, follow the repo's convention for recording a former number; the rename is its own commit |
| `add/add` in two different document formats | translate one side into the other's format and allocate identifiers; verify by counting entries, not by the absence of markers |
| genuinely incompatible | the side matching the integration's goal wins; the trade-off goes in the decision ledger. Never invent behaviour neither side had |

A conflict that replays on a later commit of the same rebase is re-read for that commit's own
intent: after the first resolution, HEAD may already hold the content and the commit's remaining
change is invisible in the markers.

## Step 5 — The conflict set is not the damage set

- The other side renamed, removed or narrowed a symbol, file, type or contract member → grep the
  branch's whole diff, added files included, for the old name. A member removed on purpose means
  the branch's dependent feature needs a new source: a decision-ledger line, not a type fix.
- Diff each auto-merged file against both parents for declarations git kept twice.
- If either side changed a dependency manifest or lockfile, run the `## worktree setup` commands
  before any check — a stale install fakes type errors shaped exactly like merge damage. Then
  `git status` the lockfile and revert drift the branch does not need.

## Step 6 — Checks at the tip

After the last commit of the rebase or the merge commit, never per resolved conflict:

1. Re-run every generated-file Command at the tip; a diff is its own commit.
2. Run every `## static checks` and `## test toolchain` command. A red check is merge damage only
   if it is green on the base: run it there (or on the base's copy of the same files) first. A
   pre-existing failure is reported, never fixed inside the resolution.
3. Where either side's contribution was a guard, an assertion or a check, prove it is still live:
   remove it, run that side's test, see it go red, restore it.

## Step 7 — Finish

- Continue the rebase to the end, or commit the merge with git's default message.
- Push. A rebase of pushed commits is pushed with `--force-with-lease=<branch>:<observed remote sha>`
  only when `## run policy` says `Force-push after rebase: with-lease`; otherwise stop and ask. A
  restriction in `## branching` always wins.
- Confirm the PR reports `MERGEABLE`. Every gate that ran before the integration is stale.
- Many PRs: name each region a sibling PR will re-conflict on once this one merges.
- Report what the conflict surfaced, not only that it is resolved.

A question in an interactive session goes to the user with options and a recommendation.

## In an unattended run

`lib/git/update-from-base.mjs` never resolves: a conflict parks the run with the base condition
`blocked` and the conflicting files named, and no lane is dispatched. A session picks it up with
this skill. When a `conflict` lane is dispatched, it follows Steps 1–7 in the run's worktree, pushes
nothing, and returns one `lane-conflict` object (`lib/contract/schemas/lane-conflict.json`):

- `resolved` — true only when no file is left and Step 6 is green at `headSha`;
- `files` — every conflicted file; `unresolved` — the ones still open;
- `questions` — each open decision with options, recommendation and evidence, for the resolver;
- `awaiting` — only what no agent can move (`harness-blocked` with the literal denial text);
- `notes` — pre-existing failures and what the conflict surfaced.

Resolving a file does not change who may merge it: the gate re-reads `## merge authority` on the
new head.
