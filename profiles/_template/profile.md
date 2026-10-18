---
profile: <name>
schema_version: 2
repo_globs:
  - "*/path/to/repo"
---

# Profile — <Project>

Facts only, never procedure. Date anything that can rot: `(measured YYYY-MM-DD)`.
Filling order and the rules that bind each section: `docs/adding-a-project.md`.
No secret values here: tokens and access codes go in `secrets.env` next to this file.

## identity

- Project:
- Kind: `code` | `document` (prose in git; the only kind that may write `## gates` as `none`)
- Jira project key:
- Board:

## tracker

- Kind: `jira` | `none` (no tracker: a run takes `--spec <path>` in place of a ticket)
- Site: <Jira site or cloudId>
- Start status: <status a started ticket moves to>
- Merged status: <status after merge> | none
- QA statuses: <backticked statuses in which a ticket waits for verification> | none

## tools

Optional. Leave it out to take the defaults in `config/tool-kinds.json` (chat `slack`, docs `notion`,
calendar `google-calendar`, email `gmail`). Server is a logical id from `config/mcp-servers.json`;
any other server is refused at launch. The tracker's kind is set above.

| Role | Kind | Server |
|---|---|---|
| docs | default | default |

## ticket conventions

Optional; `none`, or leave it out, when the tracker's own required fields are the whole convention.

- Source: <link to the written ticket guide these facts are copied from>
- Browse URL: <tracker URL a ticket key is appended to>
- Components per ticket: <exactly one | any | none>
- Issue types: <per project, measured YYYY-MM-DD>
- Priority: <scheme, and the signal behind each default>
- Personas: <who user stories are written for, and the surface each uses>
- Internal vocabulary a ticket must not carry: <skill names, private numbering, local paths>
- Product knowledge: <path to product notes read before drafting> | none
- Board snapshot: <path to a local board snapshot to read before a live search> | none

| Component | Covers |
|---|---|
| | |

| Project key | Use for |
|---|---|
| | |

## board

none — flow-pm audits and writes nothing. Otherwise:

- Acts on: <whose tickets pm may change; every other ticket is read only>
- Reads: <extra project keys read for dated work that could land on the owner> | none
- Writes: none | <subset of `transition`, `assignee`, `priority`, `comment`>
- Verified status: <status a merged and verified ticket moves to>
- Release status: none | <status between verified and released, and which repos gate it>
- Canary: <a ticket key known done and terminal>
- WIP limit: <in-progress tickets before pm proposes parking one>
- State dir: <where the status log and the board snapshot live>
- Owned columns: none | <statuses another lane owns; pm never moves into or out of them>
- Deadline sources: <regulatory gates, calendar, the owner's chat handle, roadmap pages>
- Forge repos: <repos swept for artefacts, when more than `## repos`>

## repos

| Repo | Local path | Role | Main | Merging to main means |
|---|---|---|---|---|
| | | | | |

## branching

- Convention:
- Worktrees: `none` | <procedure>
- Integrating main: rebase | merge
- Workspace-level git restrictions: `none` | <what, and where it is written>

## conventions

## decision ledger

`docs/superpowers/decisions/<TICKET>.md` unless this project says otherwise.

## merge authority

`unconfirmed` — every merge parks with the PR open on the ready-to-sign list until this table is
filled. Do not delete this line to make a run go through; fill the table instead.

One of `agent`, `agent, after <precondition>`, `human`, `unconfirmed` per row. Paths are backticked
globs; the most specific glob wins, and a path no row lists takes the strictest authority in the
table, never less than `human`.

| Path | Who merges |
|---|---|
| `**` everything | `unconfirmed` |

## environments

- Hosts: <staging / production, each with the surface it serves>
- Surface map: <which deploy workflow or bucket publishes which surface>
- Deployed SHA: <where the running build states its version, or `none` — no way to read it>
- Test users: <how to sign in as one; where credentials live, never their values>
- QA browser: `none` | <instrument, evidence directory, profile directory, origins it is scoped to and who may widen them>

## test toolchain

| Lane | Runner | Command | Proof gate before judging |
|---|---|---|---|
| | | | |

## static checks

Optional. Run once before the review axes; a Check name is one word. `n/a` or `none` if there are none.

| Repo | Check | Command |
|---|---|---|
| | | |

## generated files

Optional. Files a tool derives (lockfiles, codegen output), and the command that regenerates each
from the repo root; `n/a` for one the agent may never regenerate. `none` if there are none.

| Repo | Glob | Command |
|---|---|---|
| | | |

## gates

Declared here, never inferred from CI. At least one row; a review bot is a gate only if listed.

| Gate | Source | Pass predicate |
|---|---|---|
| | `check: <name>` \| `check: *` \| `command: <cmd>` \| `bot: <login>` | |

## run policy

- Day ceiling: <open decisions per day before the day run stops>
- Max parallel: <tickets at once>
- Fix rounds: 2
- CI fix rounds: 2
- Ceiling exclusions: none | <decision kinds not counted>
- Stop hour: none | HH:MM
- Force-push after rebase: never | with-lease
- Locked artefacts: none | <paths only one ticket may touch at a time>

## inviolables

none | one item per hard stop the resolver may never trade, each ending `Source: <where it is written>`

## owner proxy

none — no unattended day run. Otherwise:

- Proxy: <role or skill that decides in the owner's place>
- Mandate: <subset of `approve-day-queue`, `start-next-ticket`, `approve-peer-step`, `resume-run`, `lift-cap-once`, `undraft-pr`>
- Hard-stop channels: every outward channel | <list>

## escalation

- Doubt log: <optional path; drop the line for $TILLER_DOUBT_LOG, else `doubts/<date>.md` next to this file>
- Human: <role that signs and answers>

## model routing

none | table `Lane | Tier` overriding the harness default

## release

## known issues

## verification register

Optional. `none`, or leave the section out, for a project that keeps no cross-ticket register.

- Path: `<one file for every ticket, never per ticket or per session>`

## charting

Maps repo: `<owner>/<maps-repo>` — or `none` if this project does not chart.
Project label: `project:<profile-name>` (every map and child issue carries it).

## commits

Optional. `none`, or leave it out, for plain Conventional Commits `<type>(<scope>): <subject>`.
Placeholders: `<ticket>`, `<type>`, `<scope>`, `<subject>`.

- Format: `[<ticket>] <type>(<scope>): <subject>`
- Ticket from branch: `[A-Z]+-[0-9]+` (regex that finds the ticket key in the branch name)
- Without ticket: `[NO-TICKET] <type>(<scope>): <subject>`
- Text language: `en` (optional; language of commit, PR and ticket text; default `en`)

<!--
Optional sections that are not part of the default profile. To enable one, add its heading
(`## worktree`, `## worktree setup` or `## security`) on a line of its own with the body below;
docs/profile-schema.md describes each.

  worktree        - Create: `<the repo's own command for a ticket worktree, naming <branch> and optionally <base>>`
  worktree setup  - table `Repo | Check | Command`, one command per check, run once after the worktree exists
  security        - Audit command: `<the project's dependency or vulnerability audit>`
-->
