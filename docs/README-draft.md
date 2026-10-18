# tiller

Project-agnostic skills and an unattended runner for Claude Code. One repository holds *how* a
ticket is opened, planned, implemented test-first, reviewed, merged and verified; a private profile
per project holds *what* differs: repo paths, merge rules, trackers, toolchain commands, who may sign.

The skills run interactively in any Claude Code session. The runner takes a ticket, or a day's queue
of tickets, and drives them end to end with no one at the keyboard: it fails closed, resumes after a
crash, caps spend in USD and escalates only what a human must decide.

## Who it is for

- One person or a small team working several codebases with the same procedure.
- Anyone who wants an agent to run tickets overnight on a laptop and find a signed-off PR, or a
  precise list of open decisions, in the morning.
- Teams that keep project facts out of shared tooling: nothing in this repository names a company,
  a product, a host or a person; the leak guard refuses a commit that does.

## Supported systems

| | Status |
|---|---|
| macOS 13+ (Apple Silicon and Intel), bash 3.2 or newer, zsh as login shell | supported, where it is developed |
| Linux (Debian/Ubuntu, Fedora, Arch; any distribution with bash 4+ and GNU coreutils) | supported; the suite has no macOS-only step except one pseudo-terminal test, which skips where `openpty` is unavailable |
| Windows | partial: the Node parts run under Node 22+; shell scripts need WSL2 or Git Bash; the keep-awake and battery guards are macOS/Linux only |

Runtimes: the Claude Code CLI (`claude`) is the only runtime verified end to end. An adapter for
Codex (`codex exec`) and a read-only adapter for any OpenAI-compatible endpoint exist but are
marked unverified; the launcher refuses to put a gate lane on them.

## Prerequisites

| Tool | Needed for | Without it |
|---|---|---|
| Node 20.11+ (22 or 24 recommended) | the runner, the tests, the contract validator | nothing runs; `.nvmrc` pins the floor |
| git 2.30+ | worktrees, linear merges, the leak guard hook | nothing runs |
| bash 3.2+ | every shell entry point | nothing runs |
| jq | profile resolution and the shell helpers | those helpers stop with a clear message naming jq |
| gh (GitHub CLI), authenticated | the PR, CI-wait and merge phases | a run parks before the PR phase; the interactive skills say so and stop |
| claude (Claude Code CLI), logged in | every lane of an unattended run | dry runs and the test suite still work; `doctor` reports it |
| caffeinate (macOS) or systemd-inhibit (Linux) | keeping a laptop awake for a day run | the run proceeds with a warning; set your power settings by hand |
| codex (optional) | the Codex adapter | adapter reports unavailable; nothing else changes |

Check everything at once, or install what is missing:

```bash
bin/doctor            # one line per requirement, exit 1 when a required tool is missing
bin/doctor --json     # the same, machine-readable
./install.sh --prereqs   # installs the missing ones through brew, apt, dnf, apk, pacman or winget; asks first
```

Every other `install.sh` call runs the same check first and refuses when a required tool is
missing. On Windows, `.\install.ps1` installs Git Bash and the rest through winget, then runs
`install.sh` inside Git Bash (see Windows below).

## How it works

```
profile (private, per project)       skills (shared)              runner (shared)
profiles/<name>/profile.md     -->   skills/flow-*/SKILL.md  -->  lib/driver/drive.mjs  (one ticket)
  facts: repos, tracker,              procedure only, every          lib/driver/day.mjs    (a queue)
  merge authority, toolchain,         skill starts by resolving      14 checkpointed phases
  escalation, inviolables             the profile or stopping        lanes = model calls with caps
```

1. **Profile resolution.** Every skill's first step runs `lib/resolve-profile.sh`. Order:
   `TILLER_PROFILE` env var, a `.tiller-profile` file at the repo root, `repo_globs` in a profile's
   frontmatter. No profile, no run: the skill stops instead of guessing.
2. **Facts, not files.** Before anything spawns, `lib/profile-facts.sh` renders the profile into a
   facts object and refuses when a required section is empty or still reads `TODO`. The runner never
   reads a profile; it reads rendered facts.
3. **Phases and lanes.** A ticket run moves through `start`, `premise`, `plan`, `implement`,
   `review`, `pr`, `ci`, `review-bot`, `confidence`, `gate`, `merge`, `qa`, `cleanup`, `logs`. Each
   phase calls lanes: one model call with a JSON schema, a USD cap, a turn cap and a wall-clock cap.
   Model tiers come from `config/routing.json`; a profile may raise a tier, never lower a gate lane.
4. **Checkpoints and resume.** Every phase writes a checkpoint and every side effect a step record.
   Relaunching with the same args skips finished phases. A crash loop hits a resume cap and parks.
5. **Escalation.** A question the phase cannot answer from the repo, the ticket or the ledger goes
   to the resolver (decides or parks), then to the owner proxy (acts only inside the mandate the
   profile grants), then to a human. Signatures are never delegated. A harness block (permission,
   classifier) goes to nobody and parks with the rule named. See `docs/escalation.md`.
6. **Caps.** Per call, per run and per day, in USD, read from `config/routing.json` and overridable
   per profile. Over the cap, the run parks as `budget-exhausted` with one open decision.
7. **Untrusted text.** Ticket bodies, PR comments, CI output and review-bot text are fenced with
   a per-run random marker and a read rule before any model sees them; fence markers found inside
   the content are flagged and recorded.
8. **Outcome.** `driver-result.json` / `day-result.json` under the state root, a journal with spend
   per lane, a decision ledger on the branch, a retro proposal file after a day. Exit codes and
   statuses are one table: `lib/contract/exit-codes.md`.

Diagrams of each layer are in the main README section "The harness in pictures"; the full contract
is `docs/harness.md`.

## Install

```bash
git clone <this repo> ~/src/tiller && cd ~/src/tiller
git config core.hooksPath .githooks            # leak guard on every commit
npm test                                       # about a minute; proves node, git and bash are fine

# 1. Shared skills and harness roles; this also writes TILLER_HOME into ~/.claude/settings.json
#    "env" (and TILLER_MACHINE), into ~/.codex/config.toml for --target codex, and into the shell rc
./install.sh all                               # symlinks every flow-* skill into ~/.claude/skills
./install.sh --agents                          # flow-resolver, flow-owner-proxy, flow-pm into ~/.claude/agents
# 2. One profile per project
lib/new-profile.sh acme                        # copies profiles/_template, seeds leak-terms.txt
$EDITOR profiles/acme/profile.md               # or: claude, then /flow-onboard-project
echo acme > ~/src/acme-web/.tiller-profile
lib/profile-facts.sh --check ~/src/acme-web    # exit 4 = a launch would be refused; fix what it names
# 3. Optional: personal skills, project-only skills, private-access hook, cross-project overview
./install.sh --setup-personal <user>
./install.sh --profile acme all
./install.sh --hooks                           # prints a settings fragment to merge, then restart
bin/doctor
```

### Windows

```powershell
git clone <this repo> C:\src\tiller; cd C:\src\tiller
.\install.ps1 all                               # then the same steps as above, through install.ps1 or Git Bash
```

`install.sh` writes `TILLER_HOME` and `CLAUDE_CODE_GIT_BASH_PATH` into `settings.json` in the
`C:/src/tiller` form. Native symlinks need Developer Mode,
otherwise skills are linked as junctions. The unattended drivers are not supported on Windows; the
interactive skills are.

Restart Claude Code after step 2 and after `--hooks`. `TILLER_HOME` must be set in the environment
of every session that runs a skill; without it each skill resolves no profile and stops, which is
correct but opaque.

Profiles, personal skills, brains and the cross-project overview repository are git-ignored. They
never leave the machine unless you put them in a private repository of your own.

## First run

Interactive, in a project checkout:

```
/flow-start-ticket ACME-123        # branch, ticket to In Progress, premise check
/flow-plan-ticket                  # plan with a seam table
/flow-tdd                          # red-green at the seams
/flow-code-review                  # two axes: standards and spec
/flow-create-pull-request
/flow-confidence-check             # verdict, in a subagent
```

Unattended, one ticket:

```bash
cd ~/src/acme-web
H="$TILLER_HOME/skills/flow-run-ticket/bin/harness.mjs"
node "$H" args --profile acme --date 2026-10-16 --ticket ACME-123
node "$H" drive --args ~/.claude/run-state/acme/2026-10-16/args-ACME-123.json
```

Unattended, a day (a queue of waves from an approved file):

```bash
node "$H" day-args --profile acme --date 2026-10-16 --queue waves.json
node "$H" drive-day --args ~/.claude/run-state/acme/2026-10-16/args-day.json
```

The day runner keeps the machine awake (caffeinate / systemd-inhibit), starts no new work after the
profile's stop hour (exit 3; relaunch the same command after that hour), stops with a handoff on a
usage limit, waits on a low battery until it charges (up to 4 hours, then ends `battery-wait`), journals a wall-clock jump (sleep or a changed
time) and re-checks the stop hour and day cap after one. `TILLER_NOTIFY_CMD` receives one JSON
event (`{kind, runId|dayId, ticket, status, reason, at}`) on stdin per park, cap, crash, stop hour,
battery pause, battery wait limit and day end (a day ended by the stop hour or the battery wait limit
sends only that event):

```sh
TILLER_NOTIFY_CMD='cat >> ~/tiller-events.jsonl'   # or any command that posts the JSON somewhere
```

Read `skills/flow-run-day/SKILL.md` for the queue format; the retro skill turns the day's records
into proposals the next morning. `lib/supervisor/supervise.sh` is the older shell supervisor; it
still works as a fallback and needs `claude` on `PATH`.

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `TILLER_HOME` | this checkout; required everywhere; `install.sh` writes it for Claude Code, Codex and the shell | unset: every skill stops |
| `TILLER_PROFILE` | profile name, overrides `.tiller-profile` and globs | unset |
| `STATE_ROOT` | where one run's state, journals and locks live | `~/.claude/run-state/<profile>/<run>` |
| `TILLER_RUN_STATE` | the profile-level run-state directory that `calibrate` folds | `~/.claude/run-state/<profile>` |
| `TILLER_NOTIFY_CMD` | shell command receiving one JSON event on stdin per park/cap/crash/day end | unset: no notifications |
| `TILLER_NO_INHIBIT` | `1` disables the keep-awake wrapper | unset |
| `TILLER_BATTERY_MIN_PERCENT` | below this, on battery, the day runner pauses before the next chunk | `15` |
| `TILLER_BATTERY_MAX_WAIT_MINUTES` | a battery pause longer than this ends the day as `battery-wait` | `240` |
| `SUPERVISE_LOG_MAX_BYTES` | legacy supervisor only: rotate its log to one `.1` file above this size | `10485760` |
| `TILLER_MACHINE`, `TILLER_MACHINE_CAPS` | machine name and capabilities for the cross-project overview | unset |

## Tests

```bash
npm test                         # every suite, one summary line per suite, exit 1 on any red
npm run lint:skills              # structural linter for skills/*/SKILL.md
node lib/contract/validate.mjs   # the contract: kinds, schemas, exit codes agree
```

The suites are hermetic: no network, no real `claude` binary, no profile. Two tests need a
pseudo-terminal and are skipped where `script(1)` is not permitted (sandboxes, some CI runners).

## Fallbacks and failure modes

| Situation | What happens | What to do |
|---|---|---|
| No profile resolves | every skill and the launcher stop with `_none` | create `.tiller-profile` or set `TILLER_PROFILE` |
| `jq` missing | the shell helper stops naming jq | `brew install jq` / `apt install jq` |
| `gh` missing or logged out | PR phase parks with kind `refused`; interactive skills say so | `gh auth login` |
| `claude` missing | `doctor` reports it; lanes report `runtime-down`; dry runs and tests still pass | install Claude Code, log in |
| Usage limit | run exits `paused-usage` with the reset time; a day run waits and continues | nothing; relaunch with the same args if the process died |
| USD cap reached | run parks as `budget-exhausted` with one open decision | raise the cap in the profile or accept the stop |
| Laptop slept through the night | on wake the day runner re-checks the stop hour and the day cap before the next chunk | plug in; set `TILLER_NO_INHIBIT` only if you want sleep |
| Crash mid-phase | relaunch resumes at the unfinished phase; finished phases are skipped by checkpoint, and a step log records which side effects already happened so the resumed phase can check before it repeats one | relaunch with the same args |
| Crash loop | the resume cap parks the run | read `driver-result.json`, fix, relaunch |
| Crash inside a PR open, merge, rebase or cleanup | the resume parks as `interrupted-step`: the step log has the start but no result | check the forge or the repository, then remove the started line from `steps.jsonl` or record the result; relaunch |
| Another process runs the ticket | launch refused with kind `locked` | wait, or kill the dead process; a dead lock is broken automatically |
| Review bot or CI text tries to instruct the model | fenced, flagged in the decision record | read the record; no action needed |
| Stop hour reached | day run exits `blocked` / `stop-hour`; children finish their current phase | relaunch next morning |
| Battery stayed low for the whole wait | day run exits `blocked` / `battery-wait` with a handoff | plug in, relaunch the same command |
| Sandbox hides `~/.local/bin` | lanes see no `claude` and report `runtime-down` | put the directory on `PATH` |

## Advice

- Fill `merge authority` in the profile first. It is the load-bearing field: who may click merge,
  which paths need a human signature, which are never touched unattended.
- Run the test suite's dry-run harness (`bash skills/flow-run-ticket/tests/run-tests.sh`) and read one
  `driver-result.json` before leaving a day unattended; the retro skill explains the records.
- Keep the profile small. A fact that is only true for one ticket belongs in the ticket; a procedure
  belongs in a skill; a profile carries facts only (`docs/profile-schema.md`).
- Let the leak guard refuse. A hit means a fact belongs in a profile, not that the list is wrong.
- Pin models in `config/models.json`; prices in `config/prices.json`. The launcher refuses an active
  model with no price.
- One worktree per run, linear history only. The runner never force-pushes unless the profile opts in.
- Read `retros/<date>.md` the next morning; apply proposals by hand. Nothing in a retro is applied.

## Layout

```
skills/flow-*/        one skill each; _shared/ holds the profile step every skill includes
lib/driver/           the Node runner: drive.mjs (ticket), day.mjs (queue), phases, lanes, adapters
lib/contract/         kinds.json, JSON schemas, exit-codes.md, validate.mjs
lib/escalation/       resolver and owner-proxy routing
lib/state/            checkpoints, step log, locks, resume
lib/journal/          spend and result journals
lib/text/             untrusted-text fencing
lib/security/         diff scan before review
lib/supervisor/       legacy shell supervisor, keep-awake wrapper
lib/testing/          run-all test entry point, skill linter, fake runtime
config/               routing, lanes, models, prices, tool kinds, agents
docs/                 harness contract, profile schema, escalation, adding a project, glossary
profiles/_template/   what a profile contains (profiles/* is git-ignored)
.githooks/            leak guard pre-commit
```

## Uninstall

```bash
find ~/.claude/skills ~/.claude/agents -maxdepth 1 -lname "$TILLER_HOME/*" -delete   # the symlinks install.sh made
rm -rf ~/.claude/run-state                                                            # run state, if you want it gone
# then remove TILLER_* from the "env" object and the private-access hook from ~/.claude/settings.json
```

## Contributing, security, licence

`CONTRIBUTING.md` for the rules (tests with every change, no project facts, no attribution
trailers), `SECURITY.md` for reporting, `CHANGELOG.md` for what changed. Licensed under the MIT
licence (`LICENSE`).
