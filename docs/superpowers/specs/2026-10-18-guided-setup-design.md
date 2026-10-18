# Guided setup — design

## Intent

A person who has just cloned tiller runs one command and ends with a harness that is ready to
work: tools installed, one or more AI providers linked and logged in, personal skills in place,
a first project profile that is launch-safe, the private-access hook merged into the agent's
settings, `TILLER_HOME` written, and a doctor verdict on the screen. No README step is required
between the clone and the first agent session.

Today every piece exists as a separate command (`install.sh` with its forms, `lib/onboard`,
`lib/new-profile.sh`, `lib/personal/generate.mjs`, `bin/doctor`) and the README strings them
together by hand. The design adds one conductor and one memorable entry point; it does not change
the pieces.

## Goals

- One command from a fresh clone to a working session, on macOS, Linux and Windows (Git Bash).
- Every question has a sensible default and is asked only when nothing can detect the answer.
- Re-running is safe: each step checks the world, skips what is done, and asks only for what is
  missing. There is no state file; the world is the state.
- Each step is also a command of its own, so a single step can be repeated without the wizard.
- Works for a first machine (create) and for a second machine (clone what the first one made).
- Supports more than one AI provider in one run.

## Non-goals and anti-goals

- No TUI, no colours beyond what the terminal already does, no model involved in the wizard.
- Nothing is installed or written outside tiller without showing the plan and asking first,
  except the files the person already asked for by choosing a step.
- The unattended driver (`flow-run-ticket`, `flow-run-day`) stays out of scope on Windows.
- Helm and brains stay optional and off the main path; the wizard mentions them at the end.
- The wizard never prints a secret and never stores one in a tracked file.
- A failure is a failure: a step that cannot finish stops the wizard with the command that
  repeats that step, never a green summary with a hole in it.

## Entry point

`bin/tiller`, a bash dispatcher, next to `bin/doctor`:

| Command | Does |
|---|---|
| `tiller setup [--yes] [--answers <file.json>]` | the wizard, all steps in order |
| `tiller doctor` | `bin/doctor` |
| `tiller install …` | `install.sh …`, unchanged |
| `tiller login [claude\|codex]` | the provider step alone |
| `tiller personal new <owner>` / `tiller personal clone <git-url> [<owner>]` | the personal step alone |
| `tiller project new <name> <repo-dir>` / `tiller project clone <git-url> [<name>]` | the project step alone |
| `tiller hooks` | merge the private-access hook into the agent settings |
| `tiller help` | the table above, one line each |

`bin/tiller` is bash because the first step runs before Node exists. After the prerequisite
step the wizard body runs in Node (`lib/setup/wizard.mjs`), since onboarding, personal generation
and doctor are already Node and a prompt loop is simpler there. Each `tiller <step>` subcommand
calls the same function the wizard calls.

The README setup section becomes: clone, `./bin/tiller setup`. On Windows `install.ps1` ends by
running `bin/tiller setup` in Git Bash instead of `install.sh`. The shell rc line that
`install.sh` already writes gains `PATH="$TILLER_HOME/bin:$PATH"` so `tiller` works from any
directory after a new shell.

## The wizard, step by step

Every step has a done-condition, checked before anything is asked. A done step prints one `ok`
line and is skipped. `--yes` takes every default; `--answers` supplies answers by step id for
runs without a terminal; no terminal, no `--answers` and a question pending is exit 4, as in
`prereqs.sh`.

1. **Tools.** `lib/setup/prereqs.sh check`; when something is missing, show the plan and run it on
   confirmation (`prereqs.sh install`). Done: check exits 0. Claude Code and Codex CLIs are not
   installed here; the provider step owns them.
2. **Providers.** Ask which to connect: Claude Code, Codex, both (default: every one already on
   PATH; if none, Claude Code). Per provider: install the CLI if absent (the same installer
   lines `prereqs.sh plan` knows for claude; the npm package for codex), link the skills
   (`install.sh --target <t> all`, which also writes `TILLER_HOME` and the agents), then check
   login with the provider's own status command and, when not logged in, run its login command
   in the same terminal. Done per provider: skills linked to this checkout and login status ok.
   Login status detection is the builder's to verify against the installed CLI versions; when a
   CLI has no status command, the wizard runs the login command and treats exit 0 as done.
3. **Hook.** Merge the fragment `install.sh --hooks` prints into `~/.claude/settings.json` with
   jq: append the `PreToolUse` and `SessionStart` entries when no entry already names this
   checkout's `private-access.sh`, keep everything else. Invalid JSON stops the step with the
   path named, as the env writer does today. Codex has no hook; the step says so once.
   Done: an entry naming this checkout's hook exists.
4. **Personal.** Ask: new, or clone an existing `personal/<owner>` repository. Owner defaults to
   the login name. New runs `install.sh --setup-personal <owner>` (its own questions), then the
   backup question below. Clone asks for the GitHub account (URL derived from the naming rule) or
   a full git URL, clones into `personal/<owner>` and runs `install.sh --personal <owner> all`.
   Done: `personal/<owner>/skills` exists and is linked.
5. **Project.** Ask: new, or clone an existing profile repository. New asks the project name and
   the repository directory (offering to `git clone` when given a URL instead of a directory),
   runs `onboard.mjs new` then `onboard.mjs ask`, writes `<name>` into `<repo>/.tiller-profile`
   and says so, and runs `install.sh --profile <name> all` when the profile ships skills. Clone
   asks for the git URL, clones into `profiles/<name>`, creates `secrets.env` from the example
   when absent (mode 600) and lists the keys left empty, then links the profile's skills. Both
   end with `lib/profile-facts.sh --check`; a new profile then gets the backup question.
   Done: at least one profile exists and is launch-safe; with several, the step is done and
   lists them.
**Backup, inside steps 4 and 5.** A directory the wizard just created is offered a private
remote, default yes, when `gh` is on PATH and logged in (otherwise one line says how to do it
later): `gh repo create <account>/<repo> --private --source <dir> --push`, after `git init` and a
first commit when the directory has no history. Naming rule, which the clone paths derive URLs
from: `tiller-personal-<owner>` and `tiller-profiles-<name>`. `secrets.env` is never committed:
the profile template's `.gitignore` is checked before the push and the step refuses without it.
Done: the directory has an `origin` remote.

6. **Optional.** One question each, default no: helm (`install.sh --helm <url>`), brains
   (pointer to `brains/_template/README.md`). Skipped silently on `--yes`.
7. **Verdict.** `bin/doctor`; then a short report: what is ready, what is still manual (secrets
   to fill, `TODO` lines in the profile, sessions to restart), and the first command to run:
   `cd <repo> && claude` (or `codex`).

## Constraints

- Bash parts: `set -euo pipefail`, shellcheck clean, same conventions as `install.sh`.
- Node parts: no dependencies beyond the standard library, tested with `node:test` under
  `lib/setup/tests/`, in the sandbox style of `lib/install/tests/install.test.mjs` (real bash,
  stub provider binaries that log argv, answers file for every question, `TILLER_HOME` and the
  settings paths overridden through the existing environment variables).
- `lib/leak-guard.sh` clean; no project or person names in tracked files.
- Windows: paths written in `C:/` form as `install.sh` does; `tiller` runs in Git Bash only.
- Idempotency is tested: a second run over a finished sandbox asks nothing and changes no file.
- Existing commands keep their behaviour; the wizard calls them and does not fork their logic.
  Extending one (a new marked rc line, a new flag) is allowed when the wizard needs it and the
  command's tests grow with it.

## Calls made after the builder check

- **Answers file:** one JSON object keyed by step (`tools`, `providers`, `hook`, `personal`,
  `project`, `backup`, `optional`); a step that drives a sub-tool with its own questions holds
  that tool's answers as a nested block, written to a temporary file and passed through
  (`install.sh --setup-personal --answers`, `onboard.mjs answer <id> <value>` per entry). No
  translation layer.
- **Hook fragment:** `install.sh --hooks` prints clean JSON (jq output) and is parsed as such. An
  existing entry naming a different checkout's `private-access.sh` is replaced, since one machine
  runs one checkout; the replacement is printed.
- **Launch-safe:** the project step passes only when `profile-facts.sh --check` ends in
  `Launch-safe`. Otherwise it stops with the refusal and the command that resumes it
  (`tiller project ask <name>`, a thin alias for `onboard.mjs ask`). The verdict step lists only
  what the check tolerates: `TODO` prose lines and empty secret keys.
- **Node installed mid-run:** after the tools step the wizard re-resolves PATH once (`hash -r`,
  the platform's install locations); when Node is still not found it stops with "open a new
  terminal and run `tiller setup` again". `install.ps1` already refreshes PATH before handing over.
- **PATH line:** `install.sh`'s rc writer gains a second marked line for `PATH`, so `tiller
  install` and the wizard agree; its tests grow accordingly.
- **`.tiller-profile`:** written after one question, default yes, because it lives in the
  person's repository; not git-ignored, left for them to commit, and the wizard says so. "No"
  falls back to a `repo_globs` entry in the profile.

## Left to the builder

- Prompt wording and the exact help text.
- The provider status and login commands, verified against the CLIs at build time.
- How `tiller` finds its checkout when invoked through the PATH entry (resolve the script's own
  directory, following symlinks).
- Whether `install.ps1` grows a `-Setup` switch or always ends in the wizard (default: always).
- The order of the two provider operations (install, then link, then login) if a CLI needs login
  before anything else.
