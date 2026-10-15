# flow-create-pull-request

Open a GitHub pull request from the current branch via `gh`.
Syncs the branch, validates commit messages against the project's commit format, finds the repo's PR template (or falls back to a minimal one), writes a why-focused description, and creates the PR as a draft.

Commit message format is owned by the companion skill [flow-create-commit](../flow-create-commit/) - this skill delegates to it for validating, repairing, and creating commits.
Install both together.

## Install

From the repo root:

```bash
./install.sh flow-create-pull-request flow-create-commit
```

Or install every skill in the repo with `./install.sh all` - see the [main README](../README.md#setup).

## When to use it

Triggers on natural phrases - no need to invoke by name:

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
2. Detects the main branch, refuses to run on it.
3. Syncs the branch with origin (push/pull as needed).
4. Uses the repo's PR template if present, otherwise a minimal fallback.
5. Writes a concise why-focused description (one or two sentences - the diff shows the what).
6. If the diff touches UI/styles/assets, captures before/after screenshots via **Claude in Chrome** and adds a **Visual changes** section (skipped when there's no visual change, no way to run the app, or Claude in Chrome isn't available).
7. If the diff adds or modifies tests, runs the suite and adds a **Test results** section with a pass/fail badge (skipped when no tests changed).
8. Creates the PR as a **draft** with `gh pr create --draft` and returns the URL.
9. Proposes inline review comments on genuinely non-obvious fragments of the diff — each with a real explanation and, where one exists, a verified (fetched, not guessed) documentation/article link — and posts only the ones the user approves individually, one at a time (skipped entirely when nothing meets that bar).

## Requirements

- GitHub CLI (`gh`) installed and authenticated
- [flow-create-commit](../flow-create-commit/) installed (for commit validation/repair)
