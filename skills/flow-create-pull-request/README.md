# flow-create-pull-request

Open a GitHub pull request from the current branch via `gh`.
It syncs the branch, validates commit messages against the project's commit format, finds the repo's PR template (or falls back to a minimal one), writes a why-focused description, and creates the PR as a draft.

Commit message format belongs to the companion skill [flow-create-commit](../flow-create-commit/), which this skill delegates to for validating, repairing and creating commits.
Install both together.

## Install

From the repo root:

```bash
./install.sh flow-create-pull-request flow-create-commit
```

Or install every skill in the repo with `./install.sh all` - see the [main README](../README.md#setup).

## When to use it

It triggers on natural phrases, without being invoked by name:

```
open a PR
create a pull request for this branch
submit this for review
```

Slash-command form with options:

```
/flow-create-pull-request                                  # title derived from latest commit
/flow-create-pull-request "Add user authentication"        # explicit title
/flow-create-pull-request --ticket-url https://tracker.example.com/browse/ABC-123
```

## What it does

1. Validates unpushed commits against the project's format (the profile's `## commits`, else `type(scope): description`); non-conforming commits are repaired via flow-create-commit.
2. Detects the main branch and refuses to run on it.
3. Syncs the branch with origin (push/pull as needed).
4. Uses the repo's PR template if present, otherwise a minimal fallback.
5. Writes a short why-focused description (one or two sentences - the diff shows the what).
6. If the diff touches UI, styles or assets, captures before/after screenshots via Claude in Chrome and adds a Visual changes section. Skipped when there is no visual change, no way to run the app, or Claude in Chrome isn't available.
7. If the diff adds or modifies tests, runs the suite and adds a Test results section with a pass/fail badge.
8. Creates the PR as a **draft** with `gh pr create --draft` and returns the URL.
9. Proposes inline review comments on genuinely non-obvious parts of the diff, each with an explanation and, where one exists, a documentation link that was fetched rather than guessed. Only comments the user approves, one at a time, are posted; none are proposed when nothing meets that bar.

## Requirements

- GitHub CLI (`gh`) installed and authenticated
- [flow-create-commit](../flow-create-commit/) installed (for commit validation/repair)
