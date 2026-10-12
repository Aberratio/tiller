---
name: flow-create-pull-request
description: Create a pull request from the current branch to main/master using GitHub CLI. Use this skill whenever the user wants to open a PR, create a pull request, submit changes for review, or push a branch for merging — even if they don't say "pull request" explicitly. Always opens as a draft; when applicable it adds before/after screenshots and a test summary.
---

# Create Pull Request

## Step −1 — Resolve the project profile (before anything else)

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file; non-zero means stop
```

Read the profile it names. Every project-specific fact this skill needs — commit format, ticket key, main branch,
branch convention, worktree procedure, ledger path, merge authority, environments, test commands,
gates — comes from there and from nowhere else.

**No profile resolves → stop and say so.** Do not fall back to the project you saw last. Applying
one project's merge rule or test command to another is the failure this whole mechanism exists to
prevent.

Automates opening a GitHub pull request: syncs the branch, validates commit messages against the project's commit format (via the flow-create-commit skill), finds or builds a PR body, and creates the PR via `gh`.

**Bundled resources:**

- `assets/pr-template-fallback.md` — minimal fallback PR body template

**Companion skill:**

- `flow-create-commit` — owns the commit format (the profile's `## commits` section, else plain single-line Conventional Commits) and the full spec. Invoke it by name for any commit that needs to be created or repaired during this workflow; never reference its files by path.

---

## Arguments

```
/flow-create-pull-request [PR title] [--ticket-url <url>]
```

- **PR title** (optional): use directly as the PR title; if omitted, derive from commits or branch name
- **--ticket-url** (optional): include a ticket link in the PR body References section

---

## Steps

### Step 0 — Validate commit messages

Commit format is owned by the **flow-create-commit** skill. Invoke it (Skill tool) to load the required format and validation checklist — its SKILL.md points to the full spec in its own `references/conventional-commits.md`. Do not reach into that skill's folder by relative path; it may not be installed alongside this one.

Get the unpushed commits on the current branch:

```bash
git log origin/HEAD..HEAD --oneline
```

For each commit, check that it matches the format flow-create-commit resolves from the profile's `## commits` section (default: `type[(scope)]: description`, no ticket prefix).

**Ticket** (only when that format carries `<ticket>`): extract from the branch name first:

```bash
git branch --show-current
```

Use the profile's `Ticket from branch:` pattern, else the first `[A-Z][A-Z0-9]+-[0-9]+` segment of the branch name (e.g. `ABC-123-my-feature` → `ABC-123`). If found, every commit on this branch should carry that key. If the branch name has no ticket, the profile declares no `Without ticket:` format, and no `--ticket-url` flag was provided, ask the user for the ticket key (e.g. ABC-123), or whether the branch has none.

**If commits don't conform:** explain which commits fail and why (wrong format, missing ticket prefix, non-standard type, multi-line message). Invoke the **flow-create-commit** skill (its fix mode) to repair them. Do not proceed until commits are valid or the user explicitly overrides.

**If the user still has uncommitted changes that belong in this PR:** invoke the **flow-create-commit** skill to commit them before continuing.

---

### Step 1 — Detect main branch

```bash
git remote show origin | grep 'HEAD branch' | cut -d' ' -f5
```

If that fails:

```bash
git branch -r | grep -E 'origin/(main|master)' | head -1
```

Store the result (typically `main` or `master`).

---

### Step 2 — Check current branch

```bash
git branch --show-current
```

If the current branch IS the main branch, stop with: "You're on the main branch — create a feature branch first."

---

### Step 3 — Sync branch with remote

```bash
git fetch origin
git status --porcelain
```

If there are uncommitted changes, ask whether they belong in this PR - if yes, invoke the **flow-create-commit** skill to commit them; if not, ask the user to stash them first.

```bash
git status -b --porcelain
```

Then handle the branch state:

- Branch not on remote → `git push -u origin $(git branch --show-current)`
- Branch behind its own remote → `git pull --rebase origin $(git branch --show-current)`
- Branch has unpushed commits → `git push origin $(git branch --show-current)`

**Then integrate the main branch if it has moved.** `main` advancing while the work was in flight is the normal case, not the exception:

```bash
git log --oneline $(git merge-base HEAD origin/MAIN_BRANCH)..origin/MAIN_BRANCH
```

Anything listed means the branch is behind. Integrate it the way the profile's `## branching` says (`facts.integrateMain`), never the other way:

```bash
git rebase origin/MAIN_BRANCH        # integrateMain: rebase
git merge origin/MAIN_BRANCH         # integrateMain: merge
```

A `TODO` there is a question for the user, not a default.

- Conflicts → stop and hand them to the user (the **flow-resolve-conflicts** skill covers the resolution); don't guess at someone else's change.
- Commits already pushed to the branch's remote → a rebase rewrites them, so a force-push follows. Ask before force-pushing; rebasing commits that exist only locally needs no permission.
- **After integrating, re-run the repo's full gate set** (tests, typecheck, lint, and any accuracy/replay gate the repo documents). The base changed, so results from before it are stale evidence — and Step 9's badge must report the post-integration numbers, not the earlier ones.

Verify the branch is fully synced before continuing.

---

### Step 4 — Find PR template

Check for project templates using the Read tool, in order:

1. `PULL_REQUEST_TEMPLATE.md`
2. `pull_request_template.md`
3. `.github/PULL_REQUEST_TEMPLATE.md`
4. `.github/pull_request_template.md`

If a project template is found, use it. If not, load `assets/pr-template-fallback.md` as the base.

---

### Step 5 — Parse arguments and generate PR title

Extract `--ticket-url` flag and the title from the arguments if provided.

If no title was given, derive one from the most recent commit:

```bash
git log --oneline -1 --pretty=format:"%s"
```

Strip everything the commit format wraps around `<subject>` to produce a human-readable title:

- Remove the ticket prefix, if the format has one (e.g. `[ABC-123] `)
- Remove `type(scope): ` or `type: ` prefix
- Capitalise first letter, remove trailing punctuation
- Keep it under 72 characters

If the commit message is generic (e.g. "WIP", "update"), fall back to the branch name:

- Remove the ticket key and the type prefixes `## branching` uses (default `<type>/`, plus common ones: `feature/`, `bugfix/`, `fix/`)
- Replace hyphens/underscores with spaces and capitalise appropriately

---

### Step 6 — Write the PR description (why, not what)

The diff already shows *what* changed — reviewers can read the code. The description's job is to explain **why** the change was made: the objective it serves, the problem it solves, or the decision behind it.

Use the commits, diff, and ticket (if provided) only as context for inferring intent:

```bash
git log origin/HEAD..HEAD --oneline
git diff origin/HEAD...HEAD --stat
```

**Three dots on every `git diff` in this skill, two on every `git log` — don't "simplify" either.** `git diff A...B` compares from the merge base, so it shows the branch's own work whatever `main` has done since; two-dot `git diff` also subtracts commits that landed on `main`, reporting them as deletions. On a branch behind an advanced `main` that turns a 4-file, 92-line change into "30 files, 1432 deletions" and misleads the size guard (Step 10), the visual-change check (Step 8) and the gating scan (Step 9b) in one go. Step 3's integration normally makes the two forms agree; three dots keep the numbers right when it hasn't run or the user declined it. For `git log`, two dots are already correct — they list the branch's own commits.

Write the description as concisely as possible — focus on the single most important reason this PR exists. Aim for one or two sentences. Do **not** write a wall of text, and do **not** list out the changes bullet by bullet; that's what the diff is for.

If the why isn't clear from the commits and ticket, ask the user rather than padding the description with a restatement of the diff.

This fills the **Description** section of the PR body.

---

### Step 7 — Build PR body

Start with the template from Step 4.

- Fill the **Description** section with the why-focused summary from Step 6.
- If `--ticket-url` was provided, add it to the **References** section.
- If a project template has placeholder text (e.g. `<!-- ... -->`), preserve it for the author to fill in on GitHub.
- Keep the body minimal — no unnecessary headers or boilerplate.
- **Never tick a checklist box on the author's behalf.** Template checklists ("I did a self-review", "I deployed it to staging", "screenshots attached", "requested security review") are the author's attestations about what *they* did. Leave every box unchecked, and list them back to the user afterwards as "still to confirm before marking ready for review". A box ticked for a step this session did not perform turns the checklist into decoration and lowers the reviewer's guard exactly where it should be raised.
- **The body must not contradict itself.** Before moving on, re-read the assembled body as one document. An open item or caveat in the prose ("not yet deployed to staging", "end-to-end not verified", "needs a CORS change first") must not sit next to a ticked box or a confident claim saying the opposite. Resolve the contradiction or surface it to the user — never ship both and let the reviewer pick.

- **Hard budget: the whole body is at most ~15 lines / 2500 characters, in English, whatever language this conversation is in.** Not a target — a limit. What earns a place is only what the reviewer cannot infer from the diff: what really changed, what is deliberately out of scope and who is closing it instead, the traps in the diff that would otherwise read as bugs, and anything that changes what the *merger* does (a required signature, a squash-only constraint). Everything else is cut, not shortened.
- **Never write into the body:** rebase or round-by-round narrative ("this round", "second review round"), test counts and badges, gate lists, diff-size sections, acceptance-criteria tables, our own numbering (`AC#1`, finding ids, severity labels), skill names or their output shapes, names of people (a regulatory signature is the one exception), and first person. Those live in the branch's decision ledger and our own artefacts.
- **The body is a document, not a log.** If a fact is already implied by another sentence in it, the sentence stays and the fact goes.

Steps 8, 9 and 9b below may add further sections to this body before the PR is created — all are conditional and safe to skip entirely when they don't apply.

---

### Step 7b — Updating the body of an existing PR

**Never append to a PR body. Rewrite it.** Read the current body, throw it away, and rebuild it from Step 7 against the same ~15-line budget with today's tree in mind — then `gh pr edit N --body-file`.

Appending is how a 15-line description becomes a 200-line one: each round's addition is locally defensible ("the reviewer should know what this round fixed"), no single edit looks unreasonable, and nothing ever re-reads the whole document. A reviewer arriving now needs the current state of the diff, not the order in which it got there. Superseded material is deleted, not kept for provenance — provenance lives in the branch's decision ledger.

Leave bot-generated blocks (a review bot's summary, ticket-link definitions) alone; they do not count against the budget.

---

### Step 8 — Capture visual changes (if applicable)

Only run this when the diff plausibly changes what something *looks like* — UI components, styles, templates, or static image assets. Skip silently for backend-only, config-only, or docs-only changes.

```bash
git diff origin/HEAD...HEAD --stat -- '*.tsx' '*.jsx' '*.vue' '*.svelte' '*.css' '*.scss' '*.less' '*.html' '*.png' '*.jpg' '*.jpeg' '*.svg' '*.gif'
```

If nothing matches, skip to Step 9.

If matches are found, capture the screenshots using **Claude in Chrome** (the Chrome extension that lets Claude drive a real browser tab) — never a headless/synthetic render, since the point is to show what a reviewer would actually see:

1. Check whether the project can actually be run and viewed (a project `run` skill, a `dev`/`start` script, Storybook, etc.), and whether Claude in Chrome is available in this session. If either is missing, add a **Visual changes** section noting this PR touches UI but screenshots weren't captured, and move on — don't block the PR on this.
2. If both are available:
   - On the **base branch** (stash/checkout as needed), launch the dev server. Use Claude in Chrome to navigate to the affected view(s), wait for the page to settle, and screenshot — "before".
   - Return to the feature branch, restore any stash, relaunch the dev server. Use Claude in Chrome to navigate to the *same* view(s) (same route, same viewport size, same data/state where possible) and screenshot — "after".
   - Save the screenshots to the scratch directory, never into the repo.
3. Host each image somewhere linkable — e.g. `gh gist create <file> --public`, then use the gist's raw content URL.
4. Add a **Visual changes** section with before/after side by side:

   ```markdown
   ## Visual changes

   | Before | After |
   |---|---|
   | ![before](RAW_URL_BEFORE) | ![after](RAW_URL_AFTER) |
   ```

Never fabricate or describe what a screenshot "would" show — only include this section when screenshots were actually captured.

---

### Step 9 — Summarize test results (off by default)

**Do not put test counts or a test badge in the body.** A reviewer reads CI for that, and the numbers are stale the moment the branch moves. Run it only when the user asks for it in that session; otherwise report the counts to them in the conversation and skip the section.

When asked for, only run this when the diff adds or modifies test files:

```bash
git diff origin/HEAD...HEAD --stat -- '*test*' '*spec*' '__tests__' 'tests/'
```

If no test files changed, skip to Step 9b.

If they did, run the project's test suite using whatever command the repo documents (`package.json` scripts, `Makefile`, `CLAUDE.md`/`README.md`). Read the actual pass/fail/total counts from the output — never estimate or guess at numbers.

Render the result as a shields.io badge (green if all pass, yellow if some fail, red if most fail) plus a one-line count, and add a **Test results** section:

```markdown
## Test results

![tests](https://img.shields.io/badge/tests-42%2F45%20passing-yellow)

42 passing, 3 failing, 45 total
```

If any tests fail, say so plainly in that line — don't let a green-looking badge bury a failure count.

A passing badge says the suite agrees with itself. It is not evidence the change is correct, and never a reason to soften a caveat elsewhere in the body.

---

### Step 9b — Call out behaviour-gating changes (if applicable)

Scan the diff for anything that changes **who sees what**: feature-flag reads, allow-lists, permission or role checks, plan/tier conditionals, environment conditionals, and any condition deciding whether a feature, route, or UI element renders at all.

```bash
git diff origin/HEAD...HEAD -G'(flag|flipper|feature|enabled|allow|permit|can[A-Z_]|visible|gate|role)' --stat
```

If nothing matches, skip to Step 10. If something does, add a **Behaviour gating** section with one line each:

- what decides availability now, and what decided it before the change;
- what a user OUTSIDE the intended audience gets — stated per environment the change ships to (dev / staging / production), because that is where they differ;
- how that off-state was verified, or an explicit statement that it wasn't.

Write this section from the code, never from the ticket's intent. If the off-state can't be determined from the diff alone because it depends on what another service sends, say exactly that and name the service — that unknown is the single most useful thing the reviewer can be told.

A one-line change to a gate is invisible inside a large diff, and it is the change most likely to reach users who were never meant to see the feature. This section exists so the reviewer is *told*, instead of having to find it.

---

### Step 10 — Create the pull request

**Size guard — run before creating.** Count the reviewable diff:

```bash
git diff origin/HEAD...HEAD --shortstat -- . ':(exclude)*lock*' ':(exclude)*.gen.*' ':(exclude)*.snap'
```

Past roughly 400 changed lines or 15 files, say so before opening and offer to split the branch into sequential PRs. A PR that size gets approved on trust rather than read, and single-line semantic changes ride through it unnoticed. The user may proceed anyway — that's their call, made knowingly rather than by default. Say the size to them in the conversation; it does not go in the body.

Always create the PR as a draft — never open it ready-for-review directly, regardless of arguments or user phrasing:

```bash
gh pr create --draft --title "TITLE" --body "$(cat <<'EOF'
BODY
EOF
)" --base MAIN_BRANCH
```

Use a heredoc so multi-line body formatting is preserved (the body from Step 7, plus any Visual changes / Test results sections from Steps 8–9).

Display the PR URL on success, noting it was opened as a draft.

---

### Step 11 — Inline review comments (off by default)

**Do not post inline comments on the PR.** An explanation worth having belongs in the code as a
short comment, or nowhere. A PR comment explaining the
diff is read once, by nobody, and rots off the line it was attached to.

Post one only when the user asks for it in this session. When they do: English, one or two
sentences, why-not-what, no links unless the user asked for a reference and it has been fetched
and verified.

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api repos/$REPO/pulls/$PR_NUMBER/comments \
  -f body="Why this is written this way." \
  -f commit_id="$(git rev-parse HEAD)" \
  -f path="path/to/file.ext" -F line=42 -f side="RIGHT"
```

---

### Step 12 — Review-bot gates (per profile)

Read the profile's `## gates` section (`facts.gates`). For every gate whose source is `bot: <login>`, that bot's green light is a merge precondition — no PR merges without it, regardless of merge autonomy. A profile that lists no `bot:` gate has none to clear here. This step handles each bot's review; it never merges anything itself.

1. **Wait for the bot to review.** For each `bot: <login>` gate, poll for a review or comments authored by that login:

   ```bash
   REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
   gh api repos/$REPO/pulls/$PR_NUMBER/reviews --jq --arg bot "<login>" '.[] | select(.user.login | startswith($bot)) | {state, submitted_at}'
   gh api repos/$REPO/pulls/$PR_NUMBER/comments --jq --arg bot "<login>" '.[] | select(.user.login | startswith($bot)) | {id, path, line, body}'
   ```

   The review can take several minutes — poll roughly every 60 s. If after ~20 minutes there is still nothing (e.g. the bot is configured to skip drafts in this repo), don't block: report that the gate is still pending and that it must be cleared before merge, then finish.

2. **Address EVERY comment from the bot — no exceptions, none skipped silently.** For each:
   - **Bot is right** → fix it as its own commit (flow-create-commit format, reference what it fixes), push, and reply under the comment that it's fixed.
   - **Bot is wrong** → reply under the comment with a substantive argument why: the repo convention it's missing, the deliberate decision recorded in the branch's decision ledger (the path the profile's `## decision ledger` gives), or the incorrect assumption it made. Never dismiss without reasons, and never resolve a thread without replying.

   Replies to bot comments are PR comments — autonomous, no per-comment approval needed.

3. **Pushed fixes trigger an incremental re-review.** Wait for it and handle any new comments the same way, until the bot has nothing unaddressed. If this loops more than twice, stop and report the remaining disagreement instead of grinding.

4. Report the final state: reviewed / green / N comments fixed / M rebutted / gate still pending.

---

## Output format

```
✅ Detected main branch: main
✅ Current branch: ABC-123-add-auth
✅ Commits validated against the project's commit format
✅ Branch synced with origin
✅ Rebased onto main (3 commits landed since branch point) — gates re-run / already up to date
✅ Using template: project / fallback
✅ Generated title: "Add JWT token validation"
✅ Visual changes captured (2 screenshots) / skipped (no UI changes)
✅ Test results: 42/45 passing / skipped (no test changes)
✅ Behaviour gating: documented (flag read changed) / skipped (no gating changes)
✅ Size: 180 lines / 6 files (under the split threshold)
✅ Pull Request created (draft): https://github.com/org/repo/pull/42
⬜ Author checklist left unchecked — 4 items for you to confirm before "ready for review"
✅ Posted 2 review comments (1 candidate skipped — why already documented in-code) / no candidates found
✅ Review-bot gate: green (2 comments fixed, 1 rebutted) / ⏳ pending — merge gate not cleared yet
```

Show clear error messages for any failures instead.

---

## Error handling

- Not a git repo → exit with explanation
- On main branch → explain, suggest creating a feature branch
- Uncommitted changes → ask to commit or stash first
- `gh` not installed → "Install GitHub CLI: brew install gh"
- No GitHub remote → "Add a GitHub remote: git remote add origin <url>"
- Commits don't conform → explain failures, offer to help fix before continuing

---

## Examples

```bash
# Automatic title from latest commit
/flow-create-pull-request

# Custom PR title
/flow-create-pull-request "Add user authentication feature"

# With ticket URL in references
/flow-create-pull-request --ticket-url https://tracker.example.com/browse/ABC-123

# Custom title + ticket URL
/flow-create-pull-request "Fix user authentication bug" --ticket-url https://tracker.example.com/browse/ABC-456
```
