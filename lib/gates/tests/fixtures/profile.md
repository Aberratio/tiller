---
profile: fixture
schema_version: 2
repo_globs:
  - "*/nowhere/fixture"
---

# Profile — Fixture

## identity

- Project: Fixture
- Jira project key: `FIX`

## tracker

- Kind: `jira`
- Site: `fixture.example`
- Start status: `In Progress`
- Merged status: `Done`

## repos

| Repo | Local path | Role | Main | Merging to main means |
|---|---|---|---|---|
| `fixture` | `/nowhere/fixture` | app | `main` | nothing deploys |

## branching

- Convention: `<KEY>-<description>`
- Worktrees: `none`
- Integrating main: rebase

## conventions

none

## decision ledger

`docs/decisions/<TICKET>.md`

## merge authority

| Path | Who merges |
|---|---|
| `core/**` | human |
| `core/theme/**` | agent |
| `infra/**` | agent, after a note to the infra owner |
| `app/**`, `docs/**` | agent |

## environments

none

## test toolchain

none

## static checks

none

## gates

| Gate | Source | Pass predicate |
|---|---|---|
| ci | `check: *` | every check green on the head |
| lint | `command: npm run lint` | exit 0 |

## run policy

- Day ceiling: 5
- Max parallel: 1
- Fix rounds: 2
- Ceiling exclusions: none
- Stop hour: 18:00
- Locked artefacts: none

## inviolables

1. Never weaken an access condition. Source: `docs/security.md`

## owner proxy

- Proxy: `fixture-proxy`
- Mandate: `start-next-ticket`, `resume-run`

## escalation

- Doubt log: `/nowhere/doubts.md`
- Human: the project owner

## model routing

none

## release

none

## known issues

none

## charting

none
