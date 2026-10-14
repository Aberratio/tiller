# Adding a project

A project joins by getting a profile. No skill is edited, ever — if a project needs the procedure
to change, that is a finding about the skill, not about the project.

`profiles/<project>/` is git-ignored: the profile, its `cases.json`, its `secrets.env` and its
`leak-terms.txt` stay on the machine that uses them.

## Before the profile

A project that does not exist yet starts with `flow-discovery`: the spec and roadmap are agreed
first, with the client or alone, and recorded in a brain. Onboarding follows once there is a repo.

An open question inside a project that already has a profile goes through `flow-brainstorm`
(`docs/brainstorming.md`): one session, one recorded decision, then a ticket.

## Scripted path

```bash
node lib/onboard/onboard.mjs new <project> <repo-dir>... --project "<Display name>"
node lib/onboard/onboard.mjs ask <project>      # remaining decisions, in the terminal
```

`new` scaffolds `profiles/<project>/` with `lib/new-profile.sh` and reads every fact a script can
establish: main branch, branch and commit conventions with their source, test and static-check
commands and lockfiles from the manifests, recorded in `profiles/<project>/detected.json`. Ticket
key, gates, merge authority and the commit format when history does not settle it are decisions,
offered as answers and stored in `answers.json`. What stays open renders as `TODO`; `ask` (or the
`flow-onboard-project` skill, through `AskUserQuestion`) asks for it, and the profile is
re-rendered and checked after every answer. Merge authority defaults to `unconfirmed`; `agent` is
accepted only from `ask` run in a terminal. `cases.json` follows the merge authority until it is
edited by hand. No model reads the repo.

`node lib/onboard/onboard.mjs drift <project>` compares any profile, generated or hand-written,
with its repos and exits 5 on a difference, a stale `measured` date, or a `## repos` table it
cannot read. TODOs and facts it could not compare (no network, unreadable branch protection) are
notes and do not fail. A generated profile carries an `onboarding: generated` line; deleting it
hands the file over to hand editing.

Left for a human either way: project names in `leak-terms.txt`, `## tools` rows other than the
defaults, and the QA statuses, environments, release and known issues prose.

## By hand

```bash
lib/new-profile.sh <project>                                           # copies profiles/_template/
lib/profile-facts.sh --check --profile profiles/<project>/profile.md   # repeat after every section
```

Then fill it, in this order. The first four decide whether a skill can run at all, the rest decide
whether it can finish.

1. **`repo_globs`** — the paths that resolve to this profile. Test it:
   `lib/resolve-profile.sh <a repo path>` must print your file and nothing else. A repo that
   cannot be matched by path takes a `.tiller-profile` file at its root, or `TILLER_PROFILE`.
2. **`## identity`** and **`## tracker`** — Jira key, site and statuses, or `Kind: none` for a
   project without a tracker, where every run takes `--spec <path>` instead of a ticket.
3. **`## merge authority`** — see below. This is the one that can do damage if it is wrong.
4. **`## gates`** — every check and review bot a merge waits for. Nothing is inferred from CI and
   no bot is assumed; a gate not listed is not waited for.
5. **`## repos`**, **`## branching`**, **`## conventions`** — what a skill needs to open work.
6. **`## test toolchain`**, **`## environments`** — what it needs to prove work.
7. **`## run policy`**, **`## inviolables`**, **`## escalation`** — what bounds an unattended run
   and where it parks. `## inviolables` is `none` only when the project really has no hard stop.
8. **`## owner proxy`** — leave it `none` unless someone may decide in the owner's place. Without
   it the project runs ticket by ticket but never as an unattended day.
9. **`## model routing`** — `none` unless a lane needs a different tier than the default.
10. **`## release`**, **`## known issues`**, **`## decision ledger`**, and the optional **`## verification register`** — what it needs to close work.
11. **`## commits`** — optional; the commit message format, if it is not plain Conventional
    Commits.
12. **`## wayfinding`** — only if the project will be charted with `/wayfinder`; otherwise `none`.
    It is last because it is the only section that also requires a commit in the project's own
    repo: see `wayfinding/README.md`.

The profile is ready when `--check` ends in `Launch-safe.` Section shapes: `docs/profile-schema.md`.

## Merge authority is the load-bearing field

Projects differ here more than anywhere else, and the difference is not technical. A project under
a medical-device obligation needs a printed name of the signer on certain merges; a project with no
regulatory file has no such constraint and merging freely is correct there. Neither answer
generalises to the other.

So the field is **three-valued**, and the third value is the default:

| Value | Meaning | A run will |
|---|---|---|
| `agent` for a path | no signature needed there | merge once every gate is green |
| `human` or a named signer for a path | that person signs | park with the PR open on the ready-to-sign list, naming the paths |
| **absent or `unconfirmed`** | nobody has established the rule for this project | **park the same way** |

**Absent means stop.** A project whose merge rule has not been established gets the strict
behaviour, not the convenient one — being wrong in that direction costs a pause, being wrong in the
other direction costs a merge that cannot be cleanly undone.

Three further rules, all earned:

- **Copy the canon, do not paraphrase it.** Where a project has a written merge rule, the profile
  links it and reproduces its path table verbatim, and the skill is told to read the canon before
  acting rather than trusting the copy.
- **A path not in the table takes the strictest option the project has.** Generalising from a
  literal path list to an intent ("this is basically a script, so an agent may merge it") is a
  known failure mode.
- **Pin the table with cases.** `profiles/<project>/cases.json` lists paths and the authority each
  must get, `{"cases": [{"path": "...", "who": "agent|human|unconfirmed"}]}`, and
  `node --test 'lib/gates/tests/*.test.mjs'` fails when an edit to the table changes one of them.

## What does not go in a profile

Secrets, tokens, access codes. A profile names *where* a credential lives (a password manager, a
vault path, `secrets.env`); it never carries the value. Values go in `profiles/<project>/secrets.env`,
mode 600. A profile is the file most likely to be pasted into a ticket or shared with another team.

## Keeping the project out of the harness

List the project's names, repos, people, hosts, chat channels and ticket key pattern in
`profiles/<project>/leak-terms.txt`, one case-insensitive extended regex per line.
`lib/leak-guard.sh` refuses any tracked file that matches, and `.githooks/pre-commit` runs it on
every commit once `git config core.hooksPath .githooks` is set.
