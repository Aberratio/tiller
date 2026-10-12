---
profile: sample-cli
schema_version: 2
repo_globs:
  - "*/sample-cli"
---

# Profile — Sample CLI

Fixture for the runner dry-run tests: a project with no tracker.

## identity

- Project: Sample CLI
- Jira project key: none
- Board: none

## tracker

- Kind: `none`

## repos

| Repo | Local path | Role | Main | Merging to main means |
|---|---|---|---|---|
| example/sample-cli | /tmp/sample-cli | command-line tool | main | publishes nothing |

## branching

- Convention: <KEY>-<short-kebab-description>
- Worktrees: `none`
- Integrating main: rebase
- Workspace-level git restrictions: `none`

## conventions

## decision ledger

`docs/decisions/<TICKET>.md`

## merge authority

| Path | Who merges |
|---|---|
| `docs/**` | agent |
| `src/**` | agent |
| `src/release/**` | human |

## environments

## test toolchain

| Lane | Runner | Command | Proof gate before judging |
|---|---|---|---|
| unit | node | `node --test` | the suite prints a count |

## gates

| Gate | Source | Pass predicate |
|---|---|---|
| tests | `command: node --test` | the command exits 0 on the PR head |

## run policy

- Day ceiling: 3
- Max parallel: 2
- Fix rounds: 2
- CI fix rounds: 1
- Ceiling exclusions: none
- Stop hour: 19:00
- Locked artefacts: none

## inviolables

- Never publish a release from an unattended run. Source: fixture

## owner proxy

- Proxy: flow-owner-proxy
- Mandate: `start-next-ticket`, `resume-run`, `undraft-pr`
- Hard-stop channels: every outward channel

## escalation

- Doubt log: docs/decisions/doubts.md
- Human: the maintainer

## model routing

none

## release

## known issues
