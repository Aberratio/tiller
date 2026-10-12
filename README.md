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
profiles/<name>/           local, git-ignored: profile.md, cases.json, secrets.env, leak-terms.txt,
                           and optionally skills/ and agents/ that only make sense for that project
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

From a fresh clone to a working session, in order:

```bash
git clone <this repo> ~/src/tiller && cd ~/src/tiller
git config core.hooksPath .githooks          # leak guard on every commit

# 1. TILLER_HOME, persistently: add to the "env" object in ~/.claude/settings.json
#    "TILLER_HOME": "/absolute/path/to/tiller"

# 2. Shared skills and harness roles
./install.sh all                              # symlink every flow-* skill into ~/.claude/skills
./install.sh --agents                         # write flow-resolver, flow-owner-proxy, flow-pm to ~/.claude/agents

# 3. One profile per project (see Profiles below)
lib/new-profile.sh acme                       # also seeds profiles/acme/leak-terms.txt with the name
echo acme > ~/src/acme-web/.tiller-profile    # or repo_globs in the profile's frontmatter

# 4. Personal skills (asks questions in a terminal; --answers <file.json> without one)
./install.sh --setup-personal <user>

# 5. Project-only skills and agents, if the profile has any
./install.sh --profile acme all               # profiles/acme/skills/* and profiles/acme/agents/*.md
```

`TILLER_HOME` must be set wherever the skills run; each skill's `Step −1` calls
`$TILLER_HOME/lib/resolve-profile.sh`. Without it every skill resolves no profile and stops, which
is the correct failure but an opaque one. Restart the session after installing.

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

A skill or agent that only makes sense for one project (a QA lane for that product, a simulator
for its domain) lives in `profiles/<name>/skills/<skill>/` or `profiles/<name>/agents/<agent>.md`
and is installed with `./install.sh --profile <name> all`.

## Personal skills

Skills about one person rather than one project (a daily note, a writing voice) are generated into
`personal/<user>/`, which is git-ignored. `install.sh --setup-personal <user>` generates and links
them, `install.sh --personal <user> all` re-links; a plain `all` never does. The mechanism and the templates: `personal/_templates/README.md`.

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
