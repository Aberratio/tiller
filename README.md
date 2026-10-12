# tiller

Project-agnostic agent skills, plus one local profile per project carrying the facts that differ.

The skills carry no project facts, so a team adopts them by writing a profile, not by forking a
skill. Nothing is installed automatically: `install.sh` symlinks into `~/.claude/skills/` only when
it is run by hand.

## Why it exists

Skills that grow inside one project absorb that project's facts: its merge-signature rule, its
worktree flow, its staging hosts, its test commands. Most of what they teach is not project-specific
at all; it is how a ticket gets opened, reviewed, tested and merged anywhere. This repo separates the
two, so any project gets the procedure without inheriting another project's merge rule.

What couples a skill to a project is hardcoded **paths, repo names, merge rules and toolchain
commands**, not the examples in its prose. Those facts live in the profile; the skill reads them.

## Layout

```
skills/flow-*/             the procedure, with no project facts in it
profiles/_template/        tracked: the starting point for a profile
profiles/<name>/           local, git-ignored: profile.md, cases.json, secrets.env, leak-terms.txt
personal/_templates/       tracked: templates for one person's generated skills
personal/<user>/           local, git-ignored: one person's skills and leak-terms.txt
lib/resolve-profile.sh     cwd -> profile, or a hard failure
lib/profile-facts.sh       profile -> the facts a Workflow script branches on, or a hard failure
lib/new-profile.sh         create profiles/<name>/ from the template
lib/leak-guard.sh          refuse tracked content that names a project, a person or a credential
lib/testing/               synthetic fixtures for tests (never a real profile)
```

Each skill opens with a `Step −1` that resolves the profile and reads it. **No profile resolves →
the skill stops.** That is the safety property the design is for: a skill must never apply one
project's merge authority to another project because it guessed.

## Setup

`TILLER_HOME` must point at this checkout wherever the skills run; each skill's `Step −1` calls
`$TILLER_HOME/lib/resolve-profile.sh`. Without it every skill resolves no profile and stops, which
is the correct failure but an opaque one.

```bash
export TILLER_HOME="$HOME/src/tiller"
git config core.hooksPath .githooks     # enable the leak guard on every commit
./install.sh all                        # symlink every flow-* skill into ~/.claude/skills
./install.sh flow-tdd                   # or just one
./install.sh --agents                   # write the harness roles (flow-resolver, ...) to ~/.claude/agents
```

## Profiles

A profile is a folder, `profiles/<name>/`, and stays on the machine that uses it:

```bash
lib/new-profile.sh acme                 # copies profiles/_template/ to profiles/acme/
$EDITOR profiles/acme/profile.md
lib/profile-facts.sh --check --profile profiles/acme/profile.md
lib/leak-guard.sh
```

Resolution order: `TILLER_PROFILE` env var → a `.tiller-profile` file at the repo root (one line,
the profile name) → `repo_globs` in a profile's frontmatter → fail.

An unattended run needs the facts as values rather than as a file, because the Workflow script it
drives cannot read files. `lib/profile-facts.sh` renders them and refuses when a required section is
unfilled, including one that still reads `TODO`:

```bash
"$TILLER_HOME/lib/profile-facts.sh" --check ~/src/acme-web
# -> per-key report; exit 4 means a launch against this profile would be refused
```

The contract (required sections, the facts object, the rule that a profile carries facts and never
procedure) is [docs/profile-schema.md](docs/profile-schema.md); filling a new one is
[docs/adding-a-project.md](docs/adding-a-project.md) and `profiles/_template/README.md`.
Credentials go in `profiles/<name>/secrets.env` (mode 600), never in `profile.md`.

## Personal skills

Skills about one person rather than one project (a daily note, a writing voice) are generated into
`personal/<user>/`, which is git-ignored. `install.sh --personal <user>` installs them; `all` never
does. The mechanism and the templates: `personal/_templates/README.md`.

## Leak guard

Every tracked file must stay free of project, company and personal facts. `lib/leak-guard.sh` scans
the files git would track against the local lists `profiles/*/leak-terms.txt` and
`personal/*/leak-terms.txt` (one case-insensitive extended regex per line), plus credential shapes.
`.githooks/pre-commit` runs it with `--staged`; `git config core.hooksPath .githooks` enables it.
A hit means the fact belongs in a profile, not that the term list is wrong.

## Skills

| Skill | Role |
|---|---|
| `flow-start-ticket` | open work on a ticket: branch, status, plan |
| `flow-plan-ticket` | turn a specified ticket into a plan |
| `flow-tdd` | build test-first |
| `flow-code-review` | two-axis review, no verdict |
| `flow-confidence-check` | final verdict on a finished branch |
| `flow-diagnose-bug` | find and prove a cause |
| `flow-decision-ledger` | record a deviation or a post-ticket agreement |
| `flow-create-commit` | commit in the profile's `## commits` format |
| `flow-create-pull-request` | open a draft PR |
| `flow-resolve-conflicts` | resolve a conflicted merge or rebase; reads `## generated files` |
| `flow-run-ticket` / `flow-run-day` | launch an unattended ticket or day run |
| `flow-resolver` | settle an open question; inviolables come from the profile (`docs/escalation.md`) |
| `flow-owner-proxy` | act in the owner's place, inside the profile's closed mandate |
| `flow-write-ticket` | write or clean up a ticket; conventions from `## ticket conventions` |
| `flow-pm` | keep the board true; mandate from `## board` |
| `flow-manual-qa` | decide which criteria need a human; register from `## verification register` |

## Wayfinding

`/wayfinder` charts a foggy effort as a map of decision tickets on "this repo's issue tracker". Here
the maps live in one private repo kept apart from every delivery board: a decision ticket is not a
deliverable, and on a sprint board it distorts the board and leaks internal vocabulary into tickets
that must carry none.

The skill is **not forked**. `wayfinding/issue-tracker-section.md` is appended to a project's
`docs/agents/issue-tracker.md`, which is the file the skill already reads, and the profile's
`## wayfinding` section names the maps repo and the project label. `wayfinding/setup-wayfinding.sh`
provisions the repo and labels once per machine. Details in `wayfinding/README.md`.
