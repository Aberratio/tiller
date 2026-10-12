# Conventional Commits Reference

Source: https://conventionalcommits.org/en/v1.0.0/

## Commit Message Format

The project's format is the profile's `## commits` → `Format:` code span. Without one:

```
<type>(<scope>): <subject>
```

Everything fits on **one line**. No body, no footers, no multi-line summaries.

### Placeholders

| Placeholder | Filled with |
|---|---|
| `<ticket>` | the ticket key (see below) |
| `<type>` | a type from the table below |
| `<scope>` | optional; when empty, drop it together with its surrounding parentheses |
| `<subject>` | present tense, concise, lowercase start, no trailing period |

A breaking change appends `!` right after the type or the `(<scope>)`, before the colon.

### Examples

Default format:

```
feat(auth): add token validation
fix: correct null check in user lookup
chore: update dependencies
```

With `Format: [<ticket>] <type>(<scope>): <subject>`:

```
[ABC-101] feat(auth): add token validation
[ABC-102] refactor(api): extract payment service
[ABC-103] feat!: redesign authentication flow
```

---

## Ticket Extraction

Only when the format contains `<ticket>`.

- The profile declares `Ticket from branch:` → its first match in the branch name is the key.
- Otherwise → the first `[A-Z][A-Z0-9]+-[0-9]+` segment:
  - `ABC-101-add-auth` → `ABC-101`
  - `feat/ABC-102-fix-login` → `ABC-102`
- No match → the profile's `Without ticket:` format if declared; otherwise ask the user for the
  ticket key, or whether the commit has none.

---

## Type Reference

| Type | When to use | SemVer impact |
|------|-------------|---------------|
| `feat` | New feature | MINOR |
| `fix` | Bug fix | PATCH |
| `docs` | Documentation only | — |
| `style` | Formatting, no logic change | — |
| `refactor` | Code restructure, no feature/fix | — |
| `perf` | Performance improvement | PATCH |
| `test` | Adding or updating tests | — |
| `build` | Build system or dependency changes | — |
| `ci` | CI/CD configuration changes | — |
| `chore` | Other maintenance tasks | — |

---

## Breaking Changes

Indicate a breaking change with `!` before the colon:

```
feat!: redesign user authentication API
fix(auth)!: remove legacy token support
```

---

## Formal Specification (v1.0.0)

1. Commits MUST carry a type (noun: `feat`, `fix`, etc.), followed by an optional scope, an optional `!`, then a colon and space. A project format may put a ticket prefix before the type.
2. `feat` MUST be used for commits introducing a new feature.
3. `fix` MUST be used for commits patching a bug.
4. A scope MAY be provided in parentheses after the type: `feat(parser):`.
5. A description MUST immediately follow the type/scope colon and space — a short summary in present tense.
6. A body and footers are part of the spec but this skill writes **single-line messages only** — omit them.
7. Breaking changes MUST be indicated by appending `!` after the type/scope, before the colon.
8. Types other than `feat` and `fix` MAY be used (see table above).
9. Units of information are NOT case-sensitive, except `BREAKING CHANGE` which MUST be uppercase (this skill uses the `!` notation instead).

---

## Validation Checklist

Before creating a PR, verify each unpushed commit on the branch:

- [ ] Matches the resolved format (ticket prefix present exactly when the format has `<ticket>`)
- [ ] Has a valid type (`feat`, `fix`, `docs`, etc.)
- [ ] Has a colon and space after type/scope
- [ ] Subject is present and concise
- [ ] Single line — no multi-line body, no trailers
- [ ] Breaking change uses `!` if applicable
