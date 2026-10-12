---
profile: acme
schema_version: 2
repo_globs:
  - "*/src/acme-web"
  - "*/src/acme-web-worktrees/*"
  - "*/src/acme-api"
---

# Profile — Acme (synthetic test fixture)

Facts only. Procedure lives in the skills. Every fact below is invented; tests read this file so
that no test depends on a real project's profile.

## identity

- Project: Acme Widget
- Jira project key: `ABC`
- MVP deadline 2030-01-31, carried on ABC-100; label `mvp-must` marks the tickets that must land.

## tracker

- Kind: `jira`
- Site: `00000000-0000-4000-8000-000000000000` (cloudId; epics ABC-100 MVP, ABC-90 PoC)
- Start status: `In Progress`
- Merged status: `In QA` — post-merge on this board, see `## release`
- QA statuses: `In QA` — a ticket waits for verification here, after merge

## ticket conventions

Organisation-wide: the same guide governs every project in this tracker.

- Source: [Creating new ticket](https://wiki.example.com/creating-new-ticket), [Raise a ticket](https://wiki.example.com/raise-a-ticket), [Projects](https://wiki.example.com/projects)
- Browse URL: `https://tracker.example.com/browse/<KEY>`
- Components per ticket: exactly one; work that spans two surfaces is two linked tickets.
- Sibling components: every child of epic ABC-100 carries `components: []`.
- Title: short and informative; "Bug", "Fix", "Login issue" are the guide's examples of what fails.

| Component | Covers |
|---|---|
| Panel | the operator-facing web app |
| Mobile | native iOS and Android apps |
| App | the end-user web client |
| API | backend services, background jobs, API endpoints |
| Admin | internal admin tooling |

| Project key (guide) | Use for | Live key |
|---|---|---|
| `ABC` | web, backend and frontend — most Panel / App / API work | `ABC` |
| `MOB` | mobile (Android / iOS) | `MOBT` |
| `OPS` | infrastructure, CI/CD, deploys, environment config | `OPS` |
| `SEC` | security work, vulnerability remediation | `VULN` |
| `SUPPORT` | customer-reported bugs and requests | `SUPPORT` |
| `MISC` | unplanned or one-off work | `SQ` |

- Live keys: the guide's `MOB`, `SEC` and `MISC` do not exist in the tracker.
- A branch name (`feature/OPS-2741-...`) is a hint to the project, never the answer.
- Issue types in `ABC`: Story, Task, Bug, Epic, Sub-task — no Question. A decision ticket there is a Task.

| Priority | When |
|---|---|
| Highest | production down, security breach, data loss |
| High | significant user or revenue impact; ships this sprint |
| Medium | standard work — most tickets |
| Low | nice-to-have, polish, low-impact tech debt |
| Lowest | backlog; blocks nothing |

- Priority defaults: incident-driven bug → High or Highest; customer-reported, single user → Medium;
  polish or refactor → Low; speculative idea → Lowest. The user confirms every priority.
- Labels: separate from Components; existing ones include `accessibility`, `performance`, `tech-debt`.
- Linking rule (guide): "If two tasks influence each other in ANY way → link them."
- Personas: Operator — uses the Panel; End user — uses the App; Admin.
- Internal vocabulary a ticket must not carry: skill names (`flow-*`), private decision numbering,
  and any local path.

## board

- Acts on: the owner's tickets — assignee is the session account, or unassigned with a PR the owner
  authored; everyone else's are read only
- Reads: `ABC`, `XYZ` — dated work anywhere that could land on the owner
- Writes: `transition`, `assignee`, `priority` — no comments: a comment is a message to the team
- Verified status: `Done`
- Release status: `Ready To Release` — used only where `## release` names a gate between merge and release
- Canary: `ABC-1` (Done, terminal)
- WIP limit: 4
- State dir: `~/.local/state/tiller/board`
- Owned columns: `Ready for testing` on XYZ — owned by XYZ verification
- Deadline sources:
  - regulatory and review gates: calendar, `docs/compliance/**` in `example-org/acme-web`
  - dated tickets in `Reads` linked to the owner's work
  - the owner's calendar, next 10 days
  - dates in epics ABC-100 / ABC-90
- Forge repos: `example-org/acme-web`, `example-org/acme-api`

## repos

| Repo | Local path | Role | Main | Merging to main means |
|---|---|---|---|---|
| `example-org/acme-web` | `~/src/acme-web` | widget engine, validation corpus, `client-new/` front end | `main` | pushes to staging |
| `example-org/acme-api` | `~/src/acme-api` | host that consumes the `practice` package | `staging`, then `main` | five-step release chain, see `## release` |

- The front end lives **only** in `client-new/`. `client/` is the old surface still served on
  `old.staging.example.com`.

## branching

- Convention: `<KEY>-<short-kebab-description>`, e.g. `ABC-101-manifest-uid-prefix`.
- **Worktree, always**: `bin/worktree new` in `acme-web`. Never `git checkout -b` in the main checkout.
- A fresh worktree needs `npm ci` before any gate — stale `node_modules` fakes a broken merge as a
  type error.
- Integrating main is **always `git rebase origin/main`**, never a merge commit. After a rebase,
  every gate is re-run, and diffs are three-dot.

## conventions

- `CLAUDE.md` / `AGENTS.md` at each repo root, plus whatever they link.
- ADRs under `docs/` — short, impersonal, no names, no first person.
- Code comments only where the code is unreadable without them; English; the non-obvious *why*.

## decision ledger

`docs/decisions/<TICKET>.md`, committed with the change.

## merge authority

The reason is regulatory: a signature record needs the printed name of the signer.

| Path | Who merges |
|---|---|
| `client/lib/**`, `client-new/lib/**`, `client-new/scripts/**` | the owner signs |
| `validation/baseline.json`, `validation/references/**`, `docs/compliance/**` | the owner only (change control) |
| `client-new/packages/practice/src/theme/**` and `client-new/packages/practice/scripts/**` | agent |
| everything else in `client-new/packages/practice/**` - incl. `WidgetPractice.tsx`, rep-counting, session result | the owner signs |
| everything else under `client-new/**` | agent |
| `docs/decisions/**` (branch decision ledger) | agent |
| `server-new/**` | agent, no DM |
| `server/**`, `.github/**` | agent, after a DM to the reviewer |

- **A path not written into this table defaults to requiring the signature.**
- `gh pr ready` in `example-org/acme-web` is standing permission. Un-drafting is not merging.
- The PR names who prepared it and who approved it.

## environments

- `old.staging.example.com` — the **old** `client/` surface.
- `staging.example.com` — the current front end.
- Deployed SHA is read from the `<head>` meta tag of the served page, never from a git tag.
- Staging as an end user: access code + year of birth.
- Prepared tester accounts on staging, codes in the team's password manager. Do not create new ones.
- QA browser: the `playwright` MCP server. Evidence directory `~/.local/state/tiller/qa-evidence/`.

## test toolchain

| Repo | Level | Command |
|---|---|---|
| `acme-web` `client-new` | unit / component (vitest, includes `packages/practice`) | `cd client-new && npm test` |
| `acme-web` `validation` | accuracy gate | `cd client-new && npm run report:check` |

- Visual regression has no local command: only two independent CI runs prove it.
- Both commands need `npm ci` in `client-new` first; without it they exit 127 and verify-claim
  reports `blocked`, not a failing test.

## worktree

- Create: `bin/worktree new <branch>`
- Runs from the main checkout, fetches origin and cuts a new branch from the current `origin/main`.
- A failed `git fetch origin` aborts it before anything is created.

## worktree setup

| Repo | Check | Command |
|---|---|---|
| `acme-web` `client-new` | install | `cd client-new && npm ci` |

- Runs once, right after the worktree is created.

## static checks

| Repo | Check | Command |
|---|---|---|
| `acme-web` `client-new` | typecheck | `cd client-new && npm run typecheck` |
| `acme-web` `client-new` | lint | `cd client-new && npm run lint` |
| `acme-web` `client-new` | test | `cd client-new && npm test` |

## generated files

| Repo | Glob | Command |
|---|---|---|
| `acme-web` `client-new` | `client-new/src/routeTree.gen.ts` | `cd client-new && npx vite build` |
| `acme-web` `client-new` | `client-new/package-lock.json` | `cd client-new && npm install` |
| `acme-web` `client` | `client/src/routeTree.gen.ts` | `cd client && npx vite build` |
| `acme-web` `client` | `client/package-lock.json` | `cd client && npm install` |
| `acme-web` `server-new` | `server-new/Gemfile.lock` | `cd server-new && bundle install` |
| `acme-web` `server` | `server/Gemfile.lock` | `cd server && bundle install` |
| `acme-web` `validation` | `validation/baseline.json` | n/a |
| `acme-web` `docs` | `docs/compliance/accuracy-report.md` | n/a |
| `acme-api` | `src/routeTree.gen.ts` | `npx vite build` |
| `acme-api` | `package-lock.json` | `npm install` |

- `baseline.json` and the accuracy report are derived, but regenerating either invalidates the
  accuracy gate (`## inviolables` 5): a conflict in them is a question for the owner.

## gates

| Gate | Source | Pass predicate |
|---|---|---|
| ci | `check: *` | every check run on the PR head has completed with success; none pending, none skipped as a substitute for a run |
| review-bot | `bot: coderabbitai` | a review by the bot whose `commit_id` is the PR head and whose body is a real review, and every bot thread answered by a fix commit or a reasoned rebuttal |

- review-bot: a check or status named after the bot, of any colour, is not a review. Neither are
  reviews or comments reading "Review limit reached", "Review skipped" or "Draft PR not reviewed",
  nor a review on any commit other than the head.
- The accuracy gate (`report:check`) must name the drift; a gate that cannot fail is not a gate.

## release

Merge to `main` in `acme-web` pushes to staging; "In QA" on this board is therefore **post-merge**.
`acme-api` is a five-step chain — `mergeable: CLEAN` is not "ready".

## known issues

No separate known-bug file; the cross-ticket record is `## verification register`.

## verification register

- Path: `~/.local/state/tiller/qa-unverified-register.md` — one file for every ticket, appended to.

## run policy

- Day ceiling: 50 open decisions per day, counted without carry-over from earlier days
- Max parallel: 2 — three local stacks, one kept for the owner's own session
- Fix rounds: 2
- Ceiling exclusions: none
- Stop hour: none — governors replace an hour limit
- Force-push after rebase: with-lease — a rebased run branch is pushed with a lease pinned to the observed remote head
- Locked artefacts: `validation/baseline.json`, `validation/references/**`, `swagger.yaml`, `docs/compliance/**` — serialised, one ticket at a time

## inviolables

A question touching one of these parks.

1. **Clinical purpose.** State what the software technically does, never what it is for clinically.
   Source: `docs/compliance/device-description-facts.md` §2.
2. **Camera privacy by construction.** Frames are never recorded or uploaded. Source:
   `docs/compliance/architecture-privacy-by-design.md` §3.2.
3. **Regulatory artifacts.** Changing a cited fact in `docs/compliance/**` needs a named human
   owner. Source: `docs/compliance/**` provenance rule.
4. **Access gates.** Never weaken a condition that decides whether a feature is available in order
   to make something pass. Source: this profile.
5. **Evidence.** Never regenerate `validation/baseline.json` to make a gate pass. Source:
   `docs/compliance/change-control.md`.
6. **Outward commitments.** A new runtime dependency or external service parks. Source:
   `docs/compliance/soup-inventory.md`.

## owner proxy

- Proxy: `owner-proxy` (a local skill), inline or as a `/loop` watchdog
- Mandate: `start-next-ticket`, `approve-peer-step`, `resume-run`, `undraft-pr`
- Hard-stop channels: chat send and scheduled send (a draft, or a DM to the owner, is allowed); email send and email draft; every calendar write
- Hard-stop paths: every `## merge authority` row not `agent`; merging a PR someone else authored.
- Not in the mandate: approving the day queue and lifting a cap.

## escalation

- Doubt log: `~/.local/state/tiller/decisions-<date>.md` — one file per day, each item carries question, options, recommendation, reversal cost, what it blocks, and an empty resolution line
- Human: the project owner — signs every merge in a signature path and resolves what the owner proxy may not

## model routing

none — harness defaults.

## wayfinding

Maps repo: `example-org/maps` (private). Project label: `project:acme`.

## commits

- Format: `[<ticket>] <type>(<scope>): <subject>`
- Ticket from branch: `[A-Z]+-[0-9]+`
- Without ticket: `[NO-TICKET] <type>(<scope>): <subject>`
