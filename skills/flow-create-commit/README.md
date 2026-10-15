# flow-create-commit

Create git commits in the project's commit format. The format comes from the profile's
`## commits` section; with none declared it is plain single-line Conventional Commits:

```
<type>(<scope>): <subject>
```

No body, no footers, no co-author trailers.
When the format carries a `<ticket>` placeholder, the skill takes the key from the branch name (the
profile's `Ticket from branch:` pattern, else the first `ABC-123`-shaped segment), picks the type
from the diff, validates the message against the checklist in
`references/conventional-commits.md`, and commits.
It also has a fix mode for repairing non-conforming commit messages (used by [flow-create-pull-request](../flow-create-pull-request/) before opening a PR).

## Install

From the repo root:

```bash
./install.sh flow-create-commit
```

Or install every skill in the repo with `./install.sh all` - see the [main README](../README.md#setup).

## When to use it

Triggers on natural phrases - no need to invoke by name:

```
commit this
create a commit for these changes
write a commit message
fix the last commit message
```

## Profile section

```markdown
## commits

- Format: `[<ticket>] <type>(<scope>): <subject>`
- Ticket from branch: `[A-Z]+-[0-9]+`
- Without ticket: `<type>(<scope>): <subject>`
```

Both `Ticket from branch:` and `Without ticket:` are optional; with no `Without ticket:` the skill
asks when the branch carries no ticket.

## Format examples

```
feat(auth): add token validation             # no ## commits section
[ABC-101] fix: correct null check in lookup  # Format: [<ticket>] <type>(<scope>): <subject>
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
Breaking changes get `!` before the colon.
Full spec: [references/conventional-commits.md](references/conventional-commits.md).
