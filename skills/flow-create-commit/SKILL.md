---
name: flow-create-commit
description: Create git commits in the project's commit format - read from the profile's `## commits` section, plain single-line Conventional Commits (e.g. "feat(auth): add token validation") when the profile declares none. Use this skill whenever the user wants to commit changes, write a commit message, amend or fix a commit message, or asks "commit this" - even if they don't mention the format. Also used by flow-create-pull-request to validate and repair commit messages before opening a PR. Fills the ticket key from the branch name when the format asks for one, picks the right Conventional Commits type, defaults to a one-line message with no co-author trailers.
---

# Create Commit

Default message shape: one line - no body, no footers, no co-author trailers. The profile's
`## commits` section may override it; today it declares the format only (`docs/profile-schema.md`),
so the default holds unless that section says otherwise. The type table, the placeholder
rules and the validation checklist live in `references/conventional-commits.md`; read it before
composing any message.

---

## Steps

### Step 0 - Resolve the commit format

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file
```

Read the profile's `## commits` section:

| Bullet | Meaning |
|---|---|
| `- Format:` | one code span over `<ticket>`, `<type>`, `<scope>`, `<subject>` - e.g. `[<ticket>] <type>(<scope>): <subject>` |
| `- Ticket from branch:` | optional; one code span, an ERE whose first match in the branch name is the ticket key |
| `- Without ticket:` | optional; the format to use when no ticket applies |

**Section absent, `none`, or no profile resolves** → plain Conventional Commits:
`<type>(<scope>): <subject>`, scope optional, no ticket prefix. This skill never stops on a
missing profile - a commit message is reversible and the default is the open standard.

### Step 1 - Inspect the changes

```bash
git status --porcelain
git diff HEAD
```

- Nothing to commit → stop with "No changes to commit."
- If only some changes belong in this commit, stage selectively with `git add <paths>`; otherwise `git add -A`.
- Never commit unrelated changes together - if the working tree mixes concerns, tell the user and propose splitting into multiple commits.

### Step 2 - Resolve the ticket (only when the format has `<ticket>`)

```bash
git branch --show-current
```

- `Ticket from branch:` declared → the first match of that ERE in the branch name is the ticket.
- Not declared → the first `[A-Z][A-Z0-9]+-[0-9]+` segment of the branch name.
- No match → use `Without ticket:` if the profile declares it; otherwise ask the user for the
  ticket key, or whether this commit has none.

### Step 3 - Compose the message

- Pick the type from the diff (type table in `references/conventional-commits.md`): `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
- Add a scope when it clarifies (e.g. `feat(auth):`). With no scope, drop `(<scope>)` with its parentheses.
- Append `!` before the colon for breaking changes.
- Subject: present tense, concise, lowercase start, no trailing period.
- Substitute the placeholders into the resolved format and run the validation checklist from the reference file.

### Step 4 - Commit

```bash
git commit -m "<the composed message>"
```

Rules:

- By default, no `Co-Authored-By` or any other trailer, and no multi-line message (see the default
  at the top).
- Show the resulting commit with `git log -1 --oneline`.

---

## Fix mode - repairing non-conforming commits

When asked to fix existing commit messages (directly, or by flow-create-pull-request):

1. List the offending commits: `git log origin/HEAD..HEAD --oneline`.
2. For each, explain what fails against the resolved format (missing ticket prefix, invalid type, multi-line, etc.).
3. Latest commit only → `git commit --amend -m "..."`.
4. Older commits → reword via `git rebase` (interactive rebase is unavailable in agent sessions; use `git rebase --exec` or ask the user to rebase manually).
5. Only rewrite commits that are not yet on the remote, unless the user explicitly confirms a force-push.

---

## Examples

No `## commits` section:

```
feat(auth): add token validation
fix: correct null check in user lookup
feat!: redesign authentication flow
```

`Format: [<ticket>] <type>(<scope>): <subject>`, branch `ABC-101-token-validation`:

```
[ABC-101] feat(auth): add token validation
[ABC-101] refactor(api): extract payment service
```
