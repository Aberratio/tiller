---
profile: widget
schema_version: 2
onboarding: generated — lib/onboard/onboard.mjs render widget rewrites this file; delete this line to edit by hand
repo_globs:
  - "*/src/widget"
---

# Profile — widget

Facts only, never procedure. Detected facts come from `detected.json` next to this file (measured <date>),
decisions from `answers.json`. Re-render instead of editing while the line above stands.
No secret values here: tokens and access codes go in `secrets.env` next to this file.

## identity

- Project: widget
- Jira project key: `WID`
- Board: not recorded

## tracker

- Kind: `jira`
- Site: `example.atlassian.net`
- Start status: `In Progress`
- Merged status: TODO
- QA statuses: TODO — backticked statuses in which a ticket waits for verification, or none

## tools

Defaults from `config/tool-kinds.json`; change a row when the project uses another tool. The tracker's kind is set above.

| Role | Kind | Server |
|---|---|---|
| chat | default | default |
| docs | default | default |
| calendar | default | default |
| email | default | default |

## ticket conventions

none — the tracker's own required fields are the whole convention until a written guide is copied here.

## board

none — flow-pm audits and writes nothing.

## repos

| Repo | Local path | Role | Main | Merging to main means |
|---|---|---|---|---|
| `widget` | `/private<root>/src/widget` | — | `main` | TODO |

Main branches read from each clone's `origin/HEAD` (measured <date>).

## branching

- Convention: `<KEY>-<number>-<details>` — 5 of 5 remote branches, e.g. `WID-1-some-work` (measured <date>)
- Worktrees: `none`
- Integrating main: rebase onto an up-to-date main
- Workspace-level git restrictions: `none`

## conventions

none found in the repos (measured <date>)

## decision ledger

`docs/superpowers/decisions/<TICKET>.md` unless this project says otherwise.

## merge authority

`unconfirmed` — every merge parks with the PR open on the ready-to-sign list until this table is
filled. Do not delete this line to make a run go through; fill the table instead.

| Path | Who merges |
|---|---|
| `**` everything | `unconfirmed` |

## environments

- Hosts: TODO
- Surface map: TODO
- Deployed SHA: TODO
- Test users: TODO — where credentials live, never their values
- QA browser: `none`

## test toolchain

| Lane | Runner | Command | Proof gate before judging |
|---|---|---|---|
| unit (widget) | npm | `npm test` | `npm ci` exited 0 first |

## worktree setup

| Repo | Check | Command |
|---|---|---|
| `widget` | install | `npm ci` |

## static checks

| Repo | Check | Command |
|---|---|---|
| `widget` | lint | `npm run lint` |

## generated files

| Repo | Glob | Command |
|---|---|---|
| `widget` | `package-lock.json` | `npm install --package-lock-only` |

## gates

Declared here, never inferred from CI. Rows confirmed by a human at onboarding.

| Gate | Source | Pass predicate |
|---|---|---|
| ci | `check: *` | every check run on the PR head has completed with success; none pending |

## run policy

- Day ceiling: 5
- Max parallel: 1
- Fix rounds: 2
- CI fix rounds: 2
- Ceiling exclusions: none
- Stop hour: none
- Force-push after rebase: never
- Locked artefacts: none

## inviolables

none

## owner proxy

none — no unattended day run until someone grants a mandate here by hand.

## escalation

- Human: Tech lead

## model routing

none

## release

- TODO

## known issues

- TODO

## verification register

none

## charting

none

## commits

- Format: `[<ticket>] <type>(<scope>): <subject>`
- Ticket from branch: `WID-[0-9]+`
- Without ticket: `<type>(<scope>): <subject>`

Measured on main: 6 of 6 recent non-bot subjects on main (measured <date>).
