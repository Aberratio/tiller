# Sub-agent briefs

Dispatch all axes in **one message**, one `Agent` call each, `general-purpose` type. Fill every `<…>` from Steps 0–3; an unfilled placeholder is the one way these briefs fail.

Each brief opens with the same **pinned context block**, because a sub-agent shares none of your session:

```
Repo: <absolute path>            Branch: <branch>            Fixed point: <sha> (<ref>)
Tree to measure installed state in: <absolute path of the worktree where THIS branch is checked out>
Diff command (use EXACTLY this, no variations): <the command pinned in Step 0.3>
Commits: <git log --oneline output, or "none — all work is uncommitted">
Untracked/new files to Read in full: <paths, or "none">
Excluded from review (do not report on these): <generated/vendored/data paths, or "none">
```

**Pin the tree, not just the repo, whenever a finding could depend on installed state** (`node_modules`, a lockfile, a built `dist/`, a generated file). A branch reviewed from the main checkout is a different tree from the worktree it lives in, and an agent told only "Repo: <path>" will measure the wrong one. In one measured case the Spec axis reported "installed package is 0.2.0, lockfile pins 0.4.0, so AC#1's only machine-checkable evidence is unreproducible" — a blocker-shaped finding. It had read the **main checkout** (locked 0.1.0, installed 0.2.0); in the branch's worktree the same three numbers were 0.4.0/0.4.0/0.4.0 and the missing export was present. The finding was false and would have held a deadline-critical PR. Give the worktree path, and say in the brief which claims must be measured there.

When the pinned command is two-dot, add on its own line:

```
Do NOT use the three-dot form (`git diff <fixed>...HEAD`) — this branch has <no commits / uncommitted work> past the fixed point and three-dot returns an incomplete or empty diff.
```

## Standards

Include: the pinned context block · the list of standards-source files found in Step 3 (paths, so the agent reads them itself) · `references/smell-baseline.md` **pasted in full** · the pre-declared deliberate deviations.

```
You are reviewing this change on the Standards axis only. Do not assess whether it implements the ticket — another agent owns that.

Standards sources (read them): <paths>
Smell baseline (your only copy — a documented repo standard overrides it, and every entry is a judgement call):
<paste references/smell-baseline.md in full>

Deliberate deviations, already decided — grade whether the decision is sound and safely documented, do not report them as violations:
- <deviation> — <one-line reason>

Before reporting, look for the repo's own precedent. For every mutation, API response, error path and trust boundary in the diff, grep the repo for a place that already handles that class — by shape, not by name — and compare. A guard that exists elsewhere and is missing here is a departure from a documented convention, not a missing nicety: report it as (a), with the precedent's `path:line` among the locations. Without this step the same defect reads as insufficient paranoia, which is a judgement call nobody has to act on.

Report, per file/hunk where it helps:
(a) every place the diff breaks a documented standard — cite the file and the rule;
(b) every baseline smell you spot — name it and quote the hunk.
Mark each finding as a hard violation (documented standard) or a judgement call (baseline smell).
Label a smell the diff extends rather than introduces as "pre-existing — amplified by this change", with the count that shows the amplification, and recommend a separate tech-debt task instead of a fix here.
Skip anything tooling already enforces (formatting, import order, lint-failing code).
Under 400 words.
```

## Spec

Include: the pinned context block · the ticket text (fetched, pasted — do not assume MCP access) · the spec addenda · any artifact the diff produces · relevant contract docs from Done blocking tickets.

```
You are reviewing this change on the Spec axis only. Do not assess style, naming, or architecture — another agent owns that.

The spec is the ticket PLUS the decisions agreed after it was written. Both are binding.

Ticket:
<pasted ticket: summary, description, acceptance criteria>

Agreed after the ticket (treat as spec, NOT as scope creep):
- <decision> — agreed with <owner> on <date/where>

Contract docs this change must obey: <paths>
Artifact this change produces — review the artifact itself, not only the code that generates it: <path>

Report:
(a) requirements the spec asked for that are missing or partial;
(b) behaviour in the diff nobody asked for (scope creep) — excluding the agreed decisions above;
(c) requirements that look implemented but where the implementation looks wrong;
(d) acceptance criteria that cannot be verified from the code at all — say what would verify them.
Quote the spec line or the agreed decision behind each finding. Read the actual source files the diff touches when the diff alone cannot tell you whether behaviour is right.
Under 400 words.
```

## Works (optional)

Runs when the user asks whether the change still works, or when the subject is someone else's branch. Include: the pinned context block · the **documented** check commands discovered from CLAUDE.md / README / the CI workflow.

```
Run this repo's own check commands on the current tree and report pass/fail per command:
<command 1>
<command 2>

The authority on what to run is what CI runs — do not invent commands, and do not fix anything.
For every failure, attribute it before reporting it:
- does it touch a file in this diff? (if not, say so — it is pre-existing)
- does it reproduce with the DECLARED tool versions? Compare the installed version against the lockfile (e.g. `node -p "require('./node_modules/<pkg>/package.json').version"`); a stale dependency tree makes lint and tests lie in both directions.
Report: command, exit status, and for each failure whether it belongs to this change, is pre-existing, or is local toolchain drift.
```
