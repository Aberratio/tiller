# Guided setup — implementation plan

Spec: `docs/superpowers/specs/2026-10-18-guided-setup-design.md`. Ledger:
`docs/superpowers/decisions/guided-setup.md`. Kind: code.

## 1. What this is

One conductor (`bin/tiller setup`) over commands that already exist, plus thin subcommands so each
step can be repeated alone. The wizard detects its done-conditions from the world, asks only for
what is missing, and ends with a doctor verdict. Nothing the pieces do today is reimplemented.

Premise, verified against the checkout on 2026-10-18:

- `install.sh` forms, `lib/setup/prereqs.sh`, `lib/onboard/onboard.mjs new|ask|answer`,
  `lib/personal/generate.mjs --answers`, `lib/new-profile.sh`, `bin/doctor` exist with the
  interfaces the spec names. `install.sh --hooks` prints clean JSON from jq.
- `claude auth status` prints JSON with a `loggedIn` boolean (Claude Code 2.1.292); `claude auth
  login` signs in. Codex: `codex login status` (exit 0 when logged in), `codex login`, installed
  with `npm install -g @openai/codex`; not installed here, so the Codex commands are verified only
  by the stubs and by the first real run.
- `profiles/_template/` has no `.gitignore`, so a backup push would carry `secrets.env`. Step 1
  adds one.
- The resolved profile `tiller` is the 2026-10-16 trial profile: its repo row points at a scratch
  clone under `/private/tmp` and its inviolable forbids any remote but the trial's bare origin.
  Neither describes this checkout (origin is `github.com/Aberratio/tiller`). The plan takes the
  conventions, gates, ledger path and merge authority (`human` for `**`) from it and nothing else;
  bringing the profile up to date is a separate task for the owner.

## 2. Decisions taken, overridable

1. Dispatcher in bash (`bin/tiller`), wizard body in Node (`lib/setup/wizard.mjs`); the tools
   step runs in bash before Node exists. Alternative beaten: all-bash wizard (prompt loop and JSON
   handling cost more than the split).
2. Provider login is detected with `claude auth status` (`loggedIn`) and `codex login status`
   (exit code); login runs `claude auth login` / `codex login` in the same terminal. Alternative:
   ask the person; beaten because the CLIs answer.
3. Codex CLI is installed with `npm install -g @openai/codex` after the tools step guarantees
   Node. Alternative: a manual line; beaten because npm is already required.
4. Provider default: every provider CLI already on PATH; none → Claude Code.
5. The hook merge replaces an entry that names another checkout's `private-access.sh`; one machine
   runs one checkout. Alternative: append; beaten because two hooks would both fire.
6. Answers file: one JSON object keyed by step; nested blocks for sub-tools, passed through as
   temporary files (`generate.mjs --answers`) or `onboard.mjs answer` calls. No translation.
7. `.tiller-profile` is written after a question, default yes, not git-ignored, and the wizard
   says it is theirs to commit. "No" adds a `repo_globs` entry to the profile.
8. The project step passes only on `Launch-safe` from `lib/profile-facts.sh --check`; otherwise
   it stops with the resume command `tiller project ask <name>`.
9. Node installed mid-run: PATH re-resolved once; still absent → stop with "open a new terminal
   and run `tiller setup` again".
10. `install.sh`'s rc writer gains a second marked line `export PATH="$TILLER_HOME/bin:$PATH"  # tiller`
    so `tiller install` and the wizard agree.
11. `profiles/_template/.gitignore` ignores `secrets.env`; `new-profile.sh` copies it as is. The
    backup step refuses a directory whose `.gitignore` does not list `secrets.env`.
12. Backup names: `tiller-personal-<owner>`, `tiller-profiles-<name>`, matching the repositories
    the owner created by hand on 2026-10-18.
13. Tests follow `lib/install/tests/install.test.mjs`: real bash and coreutils, stub binaries that
    log argv (`claude`, `codex`, `gh`, `git` where the real one is not needed, `npm`), every path
    overridden through environment variables; no network, no real login.
14. Windows is not exercised by tests; `install.ps1` and the junction path are verified by the
    owner's run (hand-off).

## 3. Seam table

| seam | test level | loop mode | deliberately not tested here |
|---|---|---|---|
| `bin/tiller` dispatch: `help`, `doctor`, `install …`, unknown command, exit codes | unit (node:test spawns bash) | spec set | `bin/doctor` and `install.sh` internals (own suites) |
| `lib/setup/wizard.mjs` engine: step order, done-condition skip, `--yes`, `--answers`, no TTY → exit 4, failure stops with the resume command, second run asks nothing and writes nothing | unit, sandbox | vertical slices | prompt wording |
| tools step: `prereqs.sh check` ok → skip; missing → plan shown, `install` on confirm; Node absent after install → stop | unit, stubs | spec set | real package managers (prereqs suite covers the plan text) |
| providers step: choice, CLI install line, `install.sh --target <t> all`, status probe, login command | unit, stubs for `claude`/`codex`/`npm` | spec set | real sign-in (hand-off) |
| hook step (`tiller hooks`): append when absent, replace other-checkout entry, keep foreign keys, invalid JSON → stop naming the file | unit, real jq | spec set | the hook's own behaviour (`lib/hooks` suite) |
| personal step: new → `install.sh --setup-personal` with nested answers; clone → `git clone` + `--personal all`; done-condition | unit, real `install.sh` + stub `git` | vertical slices | the generator's questions (its suite) |
| project step: new → `onboard new` + answers + `.tiller-profile` + `--profile all` when skills exist; clone → `git clone`, `secrets.env` from example (600), empty keys listed; `--check` gate | unit, real onboard/new-profile/profile-facts + stub `git` | vertical slices | onboard's detection (its suite) |
| backup sub-step: `.gitignore` refusal, `git init`+commit when no history, `gh repo create --private --source --push`, skip when gh absent or logged out | unit, stub `gh`/`git` | spec set | a real push (hand-off) |
| `install.sh` rc PATH line | unit, extend `install.test.mjs` | spec set | shell start-up itself |
| template `.gitignore` through `new-profile.sh` | unit, extend `lib/onboard` or new-profile test | spec set | — |
| `install.ps1` → `bin/tiller setup`; README, README-draft, CHANGELOG, glossary, harness.md | none (non-behavioural) | — | verified by the Windows run and by reading |

## 4. Steps

1. **Ground work** — `profiles/_template/.gitignore` (`secrets.env`), `install.sh` rc PATH line
   with its test, `--hooks` unchanged. Unit. Agent.
2. **Dispatcher** — `bin/tiller` with `help`, `doctor`, `install`, and a stub `setup` that execs
   the Node wizard; resolves its own directory through symlinks. Unit. Agent.
3. **Engine, tools step, verdict** — `lib/setup/wizard.mjs`: step registry with
   `done()`/`run()`, answers file, `--yes`, TTY rule, the resume-command failure shape, the tools
   step (bash `prereqs.sh` under the hood), the final doctor + report. Includes the idempotency
   test harness every later step reuses. Unit. Agent.
4. **Providers and hook** — provider choice, install, link, status, login; `tiller login`;
   `tiller hooks` merge. Unit. Agent.
5. **Personal and project** — both modes each, `tiller personal new|clone`,
   `tiller project new|clone|ask`, `.tiller-profile`, secrets listing, `--check` gate. Unit. Agent.
6. **Backup** — the sub-step inside 4 and 5 of the wizard, `.gitignore` refusal, gh presence and
   login probe (`gh auth status`). Unit. Agent.
7. **Windows and docs** — `install.ps1` hands over to `bin/tiller setup`; README setup section
   becomes clone + `./bin/tiller setup`; README-draft, CHANGELOG, glossary (`tiller`, `wizard`),
   harness.md paragraph. Non-behavioural. Agent writes, owner verifies on Windows.

Gates before each commit: `npm test`, `npm run lint:shell` (shellcheck), `npm run lint:skills`,
`bash lib/leak-guard.sh`. Commits: single-line Conventional Commits, one per step or two.

## 5. Hand-offs and gates

| step | owner | command | fallback |
|---|---|---|---|
| commit and push every step | owner (sandbox has no credentials) | `git push origin main` | agent commits locally, owner pushes |
| real provider login on a fresh machine | owner | `./bin/tiller login claude` | `claude auth login` by hand |
| real backup push | owner, with `gh` logged in | `./bin/tiller personal new <owner>` then answer yes | `gh repo create … --push` by hand |
| Windows run of `install.ps1` → `tiller setup` | owner, on the Windows machine | `.\install.ps1` | paste the output; agent fixes |
| profile `tiller` brought up to date (repo row, inviolable) | owner | edit `profiles/tiller/profile.md` | none; the plan does not depend on it |

Merge authority: `human` for `**`, so every merge is the owner's regardless of where a seam
lands; no seam buys an extra signature.

## 6. What no test level reaches

Needs a human or a machine: the Windows run (junctions, `C:/` paths, PATH refresh), a real
sign-in to Claude Code and Codex, a real `gh repo create --push`, the first `claude` session in a
project repo after the wizard.

Non-behavioural: README and README-draft setup sections, CHANGELOG entry, glossary rows,
harness.md paragraph, the naming rule for backup repositories, the trial profile's staleness.

## 7. Traceability

| criterion (spec) | satisfied by |
|---|---|
| one command, three OSes | steps 2, 3, 7; Windows hand-off |
| defaults, ask only when undetectable | step 3 (engine), 4, 5 |
| re-run safe, no state file | step 3 idempotency harness, every step's `done()` |
| each step is its own command | steps 2, 4, 5 |
| first machine and second machine | steps 5 (clone modes), 6 (backup) |
| several providers in one run | step 4 |
| no TUI, no model | step 3 (plain prompts) |
| ask before writing outside tiller | step 3 (tools confirm), 5 (`.tiller-profile` question) |
| drivers out of scope on Windows | step 7 docs, unchanged |
| optional helm and brains | step 3 verdict text, optional step (`--yes` skips) |
| never prints a secret | step 5 test: empty keys listed by name only |
| failure stops with the resume command | step 3 engine test |
| hook merged, not pasted | step 4 |
| `TILLER_HOME` written | existing `install.sh` (called by step 4) |
| doctor verdict at the end | step 3 |
| `PATH` line | step 1 |
| backup with naming rule, `secrets.env` never pushed | steps 1, 6 |
