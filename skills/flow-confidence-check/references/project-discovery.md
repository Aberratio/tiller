# Project discovery

Run at the start of EVERY invocation.
The skill carries no per-repo config - every fact comes from the repo's own docs, stack detection, or the user, in that order.
Record the source of each fact; the report shows it.

## 1. Read the repo's docs

- Root CLAUDE.md and every file it references (@-links and explicit path mentions).
- README.md and CONTRIBUTING.md.
- Per-directory CLAUDE.md / AGENTS.md files adjacent to the changed files (test conventions usually live near the tests).

Extract when present:
- Scoped test command (single file / directory) and the command wrapper convention (docker wrapper, make target, bin/ script). Note the full-suite command only to AVOID it. Used ONLY for fix verification in the auto-fix loop - the review path never executes tests.
- Lint command(s); a diff-scoped lint runner if documented. Same: fix verification only.
- Test layout: where boundary/e2e tests, unit tests, and browser tests live; any deprecated test patterns (e.g. controller specs in Rails).
- Browser-test selector convention (e.g. `data-test-id`).
- Generated-file and data-bloat globs.
- Ticket/branch conventions and ticket URL prefix.
- A gitignored scratch directory for saving reports (e.g. `tmp/`); fallback: system temp.
- Default branch: `git symbolic-ref refs/remotes/origin/HEAD` (fallback: `main`).
- Review learnings (team-agreed suppression rules): a `## Review learnings` section in root CLAUDE.md first, then `doc/review-learnings.md`. Load the entries verbatim into the `{LEARNINGS}` slot of the agent preambles (dimension agents AND verifiers). Neither present: empty learnings, no prompt, skill behaves as before.
  Entry format (one per bullet, greppable): `- [<category>] <rule> (added <YYYY-MM-DD>, from <branch or PR>)`.
  Agents apply a learning's scope literally - a precisely-worded rule (exact paths, patterns, conditions) suppresses reliably; an imprecise one silently fails to fire. Draft entries with exact scope, and prefer too-narrow over too-broad.
- Previous-run state file: `<repo>/tmp/flow-confidence-check/<branch-slug>.json`. Relies on the repo's `tmp/` gitignore - warn when `tmp/` is not ignored. Missing file = first run, no delta markers.

## 2. Stack-detection fallback (only where docs are silent)

| Signal | Scoped test | Lint | Browser tests |
|---|---|---|---|
| Gemfile + spec/ | `bundle exec rspec <files>` | `rubocop <files>` | spec/features (Capybara) |
| package.json | `npx jest <files>` or `npx vitest run <files>` (per deps) | `npx eslint <files>` | playwright/ or cypress/ dirs |
| go.mod | `go test ./<changed packages>` | `golangci-lint run`, or `make lint` if the target exists | - |
| pyproject.toml / pytest.ini | `pytest <files>` | `ruff check <files>` | - |
| mix.exs | `mix test <files>` | `mix credo` | - |

Verify a candidate exists before trusting it: bin/ scripts, package.json "scripts", Makefile targets.
Never guess-run a command that appears nowhere.

## 3. Missing essentials: ask, then document

If no scoped test command or no lint command is discoverable: proceed with the review (it never executes them), but resolve before the auto-fix loop runs - ask the user then.
Then offer to write the answer into the repo's root CLAUDE.md (or a doc it links, e.g. CONTRIBUTING.md) so the next run self-serves.
This is the skill's convention: project setup belongs in the project's docs, never in the skill.

## 4. Ticket cascade (generic)

Each hit is stamped as `spec-source` (see SKILL.md Phase 1): `file` / `jira` / `author` / `conversation` / `none`.

1. Explicit skill argument (text or file path) wins -> `file` (or `author` when the argument is AC text the user wrote).
2. Branch matches the ticket pattern (the profile's `## commits` → `Ticket from branch:`, else `[A-Z]+-\d+`) AND the tracker's MCP is connected (tracker kind `jira`: the Atlassian MCP): fetch the issue, condense to <= 15 lines (goal, acceptance criteria, constraints, out-of-scope) -> `jira`.
3. Branch or recent commits mention `#123` AND `gh` is available: `gh issue view 123` -> `jira`.
4. User explicitly typed the acceptance criteria in this conversation -> `author`.
5. ACs derived from conversation context or a grep of the repo's docs/plans directories -> `conversation`; NEVER silent - echo the derived ACs back and require explicit confirmation before review dispatch.
6. Nothing: STOP and ask the user for the change's intent. Never self-declare "no spec" - only the user can; user confirms none -> skip spec-alignment, stamp `spec-source: none` (disqualifies high-confidence).

Prior flow-confidence-check reports and state files are delta inputs only - they never satisfy any step of this cascade.

## 5. Output of discovery

A short block the later phases (and the report) reuse verbatim, with the source of each fact:

```
discovery:
  default_branch: main                                   (source: git)
  test_scoped:  bin/docker exec dev bin/rspec <files>    (source: CLAUDE.md)
  lint:         bin/pronto c                             (source: CLAUDE.md)
  browser_selectors: data-test-id                        (source: CLAUDE.md)
  controller_tests: deprecated                           (source: spec/CLAUDE.md)
  excluded_globs: db/schema.rb, ...                      (source: fallback + CLAUDE.md)
  report_dir: tmp/flow-confidence-check/                   (source: fallback)
  learnings: 4 entries via doc/review-learnings.md       (source: repo docs; or "none")
  state_file: tmp/flow-confidence-check/<branch-slug>.json (source: convention)
  ticket: ABC-1234 via Jira MCP                          (spec-source: jira)
```
