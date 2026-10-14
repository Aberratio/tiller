# Project profile — the contract

A generic skill contains the *procedure*. A profile contains every fact that changes between
projects. A skill never hardcodes a repo name, a path, a Jira key, a host, a merge rule or a review
bot; it reads them from the active profile.

## Resolution

`lib/resolve-profile.sh` maps the current working directory to a profile, in this order:

1. `TILLER_PROFILE` env var (explicit override, wins over everything)
2. `.tiller-profile` file at the repo root (one line: the profile name)
3. `profiles/<name>/profile.md` whose `repo_globs` matches the repo path (longest glob wins)
4. no match → the skill says so and asks; it never guesses

A skill that needs a profile and cannot resolve one **stops**. A guessed profile applies one
project's merge rule to another project's branch.

**Environment overlay.** With `TILLER_OVERLAY=<env>`, `profiles/<name>/overlays/<env>.md` is layered
over the resolved profile: each of its `## ` sections replaces the profile's section of the same heading
whole, or is appended; text before its first section is ignored. The merged file is written to
`profiles/<name>/.merged-<env>.md` and that path is printed, so prose readers and `profile-facts.sh`
read the same profile. A missing overlay, or one that sets `## merge authority`, `## inviolables` or
`## owner proxy`, is refused: an environment must not loosen the owner's authority.

## Schema version

The frontmatter carries `schema_version`; absent reads as `1`. `lib/profile-facts.sh` states the
range it reads and refuses a profile outside it, older or newer. This document describes version 2.

## Required sections

Every profile has these headings, in this order. A section with nothing in it says `none`, never
nothing — a missing section reads as an oversight, an explicit `none` reads as a decision. `none`
may be followed on the same line by a dash and the reason.

| Section | What it carries | Consumed by |
|---|---|---|
| `## identity` | project name, Jira project key(s), board name | start-ticket, plan-ticket, pm |
| `## tracker` | `Kind` (`jira` \| `none`), `Site`, `Start status`, `Merged status`, optional `QA statuses` | start-ticket, pm, run-ticket, manual-qa |
| `## tools` | optional table `Role \| Kind \| Server` over the roles in `config/tool-kinds.json` (tracker, chat, docs, calendar, email). A role left out, or `default` in a cell, keeps the default kind and server; a Server outside `config/mcp-servers.json` is refused; Kind `none` grants that role nothing. The tracker's kind comes from `## tracker`, so a tracker row only picks the server. Skills and roles name `role:<role>.<op>`, never a vendor tool | run-ticket, run-day, install-agents |
| `## ticket conventions` | optional; the project's written ticket-writing rules copied from their canon: `Source:`, browse URL, components, project routing, priority scheme, issue types, personas, labels, the internal vocabulary a ticket must not carry. Read as prose, not rendered; `none`, or the section left out, means the tracker's own required fields are the only convention | write-ticket |
| `## board` | optional; which tickets pm acts on, which tracker writes it may make (closed list), the verified status, a known-done canary ticket, the WIP limit, where its log and snapshot live, and the deadline sources. Absent or `none`: pm audits and writes nothing | pm |
| `## repos` | table: repo → local path, role, main branch, what merging to main means | every skill |
| `## branching` | branch name convention, worktree procedure (or `none`), how main is integrated | start-ticket, tdd |
| `## conventions` | paths to the repo docs that define test levels, mocking rules, code style | code-review, tdd, confidence-check |
| `## decision ledger` | path template for the branch ledger | decision-ledger, reviews |
| `## merge authority` | who may click merge, per path glob | gate evaluator, pull-request |
| `## environments` | staging/prod hosts, which deploy publishes which surface, how to read the deployed SHA, how to log in as a test user; for QA with a browser, the instrument, its evidence directory and the origins it is scoped to | qa, manual-qa, diagnose-bug |
| `## test toolchain` | per repo: the runner, the command (one code span or `n/a`; verify-claim runs it under `sh -c`, `--check` refuses prose), what a lane must prove before it judges | tdd, qa, verify-claim |
| `## worktree` | optional; `- Create:` followed by one code span, the repo's own command for a new ticket worktree, naming `<branch>` and optionally `<base>` (no other placeholder). The runner runs it under `sh -c` from the primary repo's checkout and finds the worktree by its branch in `git worktree list`, so the command decides where it lives. `none`, or the section left out, means plain `lib/git/worktree.mjs` | runner |
| `## worktree setup` | optional; per repo: a one-word Check name and its Command (same rule as `## static checks`). The runner runs each once, right after the worktree is created, before anything else reads it — a fresh `git worktree` starts with no `node_modules`. One that cannot run (e.g. `npm ci` with no network) is `blocked`, kind `toolchain`, and does not stop the run early; `none`, or the section left out, for a project whose worktree needs no setup | runner, gate evaluator |
| `## static checks` | optional; per repo: a one-word Check name and its Command (same rule as `## test toolchain`). The runner re-runs each before the review axes and the axes do not raise what they cover; one that cannot run is `blocked`, kind `toolchain` | runner, review axes |
| `## security` | optional; `- Audit command:` followed by one code span, the project's dependency or vulnerability audit (e.g. `npm audit --audit-level=high`). `lib/security/scan-diff.mjs` reads it from `profilePath` (not rendered; referred to as `security.auditCommand`) and runs it under `sh -c` in the worktree at every confidence pass; a non-zero exit is a high finding, and prose, `TODO` or a command that cannot run is a high finding held for the gate. `none`, or the section left out, runs no audit; credential shapes and dependency-file changes are scanned either way | confidence-check, runner |
| `## generated files` | optional; table `Repo \| Glob \| Command`: files derived by a tool, and the one code span that regenerates them from the repo root (`n/a` for a derived file the agent may never regenerate, which makes its conflict a question). Globs are backticked; `--check` refuses prose commands, glob cells with no backticked glob and `TODO`. Not rendered. `none`, or the section left out, declares no generated files: every conflicted file is then hand-written, and one that announces itself as generated is a question, never a guess | resolve-conflicts |
| `## gates` | table: gate → source → pass predicate | gate evaluator, pull-request |
| `## run policy` | day ceiling, parallelism, fix-round caps, locked artefacts | run-day, run-ticket |
| `## inviolables` | the resolver's hard stops, each with its source; `none` if there are none | resolver |
| `## owner proxy` | who decides in the owner's place, and the closed mandate; `none` for no proxy | run-day, resolver |
| `## escalation` | where parked decisions are written and which human answers them | every phase that parks |
| `## model routing` | `Lane \| Tier` overrides of the harness default; `none` for defaults | run-ticket |
| `## release` | what happens after merge to main, and how far | pm, qa |
| `## known issues` | path to the file that stops a known bug being refiled | qa, diagnose-bug |
| `## verification register` | optional; `- Path:` with one backticked path — the cross-ticket register of criteria nobody has verified. One file, never per ticket. `none`, or the section left out, for a project that keeps none | manual-qa |
| `## wayfinding` | where this project's maps live and how to scope them; `none` if the project does not chart | wayfinder |
| `## commits` | optional; the commit message format, how a ticket key is found in the branch name, and the format for a commit with no ticket. `none`, or the section left out, means plain Conventional Commits | create-commit, create-pull-request |

### Tracker

`Kind: jira` requires `Site`, `Start status` and a Jira key in `## identity`. `Kind: none` is a
project with no tracker: a run takes `--spec <path>` in place of a ticket, and no phase transitions
or comments anywhere. `Merged status` is optional; absent renders as `null`. `QA statuses` lists, backticked, the statuses in which a ticket waits for verification; it is read by the QA skills, not rendered.

### Ticket conventions

Bullets and tables, each a fact copied from the canon the `Source:` line names (one or more links);
the canon wins when the two disagree. Values that were checked against the live tracker carry
`(measured YYYY-MM-DD)`, because a written guide drifts from the tracker it describes. `--check`
refuses a declared section with no `Source:` line or a `TODO` in it; it renders no facts key, since
only an agent writing a ticket reads it, through `profilePath`.

Absent or `none`: no project rule beyond what the tracker itself requires. With `## tracker`
`Kind: none` the section may still carry personas and vocabulary; tracker fields in it are unused.

### Board

`Acts on` says whose tickets pm may change; everything else is read only. `Writes` is `none` or a
subset of `transition`, `assignee`, `priority`, `comment` — anything else refuses the profile.
`Verified status` is required when `transition` is listed. `Canary` is a ticket key known to be
done and terminal; the blocker check refuses to issue a verdict unless the canary reads done.
`WIP limit` is a positive integer. `State dir` holds the status log and the board snapshot.
`Reads`, `Release status`, `Owned columns`, `Deadline sources` and `Forge repos` (repos swept for
artefacts beyond `## repos`) are optional. A board on a
profile with `Kind: none` refuses.

### Merge authority

A table `Path | Who merges`. The path cell lists backticked globs (`dir/**`, `*.md`, `**`); a cell
starting with "everything" and naming no glob means `**`. The who cell starts with one of:

- `agent` — the agent may merge once every gate is green.
- `agent, after <precondition>` — as `agent`, plus a condition that stays `blocked` until the
  precondition is confirmed for this head.
- `human` (or a named signer) — the agent parks with the PR open on the ready-to-sign list.
- `unconfirmed` — nobody established the rule; treated as `human`.

A row with no glob, a glob abbreviated with `...`, or a `TODO` refuses the profile. A path is
written in full even when a shorter form is how people say it.

### Gates

A table `Gate | Source | Pass predicate`, at least one row, names unique. Source is one of:

| Source | Observed as |
|---|---|
| `check: <name>` | the named check run on the PR head |
| `check: *` | every check run on the PR head |
| `command: <cmd>` | a command run against the head, exit 0 = green |
| `bot: <login>` | a review by that account on the head commit |

Gates are declared, never inferred from the CI present in a repo, and there is no harness-wide
default bot: a project that wants a review bot as a gate lists it. The pass predicate is prose the
observer applies; notes below the table refine it.

A note bullet that starts with `<gate name>:` may quote phrases in double quotes; for a `bot:` gate
each quoted phrase is a text meaning the bot skipped the review (a rate limit, a skipped draft).
They render as literal, case-insensitive skip patterns.

### Run policy

`Day ceiling` and `Max parallel` are positive integers. `Fix rounds` and `CI fix rounds` default to
the caps in `lib/contract/kinds.json` and may not exceed their maximum. `Ceiling exclusions` lists
decision kinds from the same file. `Stop hour` is `none` or `HH:MM`. `Locked artefacts` lists paths
only one ticket may touch at a time. `Force-push after rebase` is `never` (the default when absent) or
`with-lease`: only `with-lease` lets the runner push a rebased branch with `--force-with-lease`
pinned to the remote head it observed; `never` parks the run instead.

### Inviolables

Bullets or numbered items; continuation lines belong to the item above. Each item names its canon
with `Source:`. An inviolable with no source cannot be checked against its canon, so it refuses the
profile.

### Owner proxy

`Proxy` names the role or skill. `Mandate` is a subset of a closed vocabulary (`mandates` in
`lib/contract/kinds.json`) — anything else refuses the profile:

| Mandate | Allows the proxy to |
|---|---|
| `approve-day-queue` | approve the day's queue in place of the owner |
| `start-next-ticket` | start the next queued ticket after one parks |
| `approve-peer-step` | approve a step another session is waiting on |
| `resume-run` | resume a paused or stopped run |
| `lift-cap-once` | lift a cap by one round, once per ticket |
| `undraft-pr` | mark a draft PR ready for review |

Merging a path whose authority is not `agent` is never in the vocabulary. `Hard-stop channels`
defaults to every outward channel. Prose that names channels narrows the list, matched by these words:
`chat send`, `schedul(e)`, `email send`, `email draft`, `calendar`, `comment`. A narrowed list only
removes channels; words matching none leave every channel a hard stop. No section, or `none`, means no unattended day run.

### Commits

Three bullets, each value one code span. Placeholders are `<ticket>`, `<type>`, `<scope>` and
`<subject>`; any other refuses the profile.

- `Format:` the message for a commit on a ticket branch. Names `<type>` and `<subject>`.
- `Ticket from branch:` an extended regex whose first match in the branch name is `<ticket>`.
  Required when `Format` names `<ticket>`.
- `Without ticket:` the message when the branch carries no ticket. May not name `<ticket>`; absent,
  it is `Format` with the ticket prefix removed.

```markdown
## commits

- Format: `[<ticket>] <type>(<scope>): <subject>`
- Ticket from branch: `[A-Z]+-[0-9]+`
- Without ticket: `[NO-TICKET] <type>(<scope>): <subject>`
```

Absent or `none`: plain Conventional Commits, `<type>(<scope>): <subject>`, no prefix.

## The facts object

A Workflow script has no `fs`, no `require`, no `process.env` and no shell; its only effect is
spawning agents with prompt strings. Facts its own predicates branch on — a merge rule compared
against a file list, a gate compared against a check result — therefore arrive as values.
`lib/profile-facts.sh` renders them, once, in bash, before anything spawns; the launcher passes the
result in `ARGS`. Sections that exist to be read rather than computed are not rendered: they travel
as `profilePath`, and the agent that needs one opens it.

| Key | Source section | Shape |
|---|---|---|
| `schemaVersion` | frontmatter | integer |
| `profile` | frontmatter `profile:` | string |
| `profilePath` | — | absolute path to the profile file |
| `jiraKeys` | `## identity` | list of strings |
| `tracker` | `## tracker` | `{kind: "jira", site, keys, startStatus, mergedStatus}` or `{kind: "none", spec: true}` |
| `tools` | `## tools` + `## tracker` Kind | `{<role>: {kind?, server?}}`, declared bindings only; `tracker.kind` always set |
| `repos` | `## repos` | list of `{repo, path, role, main, mergingMeans}` |
| `branchConvention` | `## branching` | string |
| `worktree` | `## branching` | string, or `none` |
| `integrateMain` | `## branching` | `rebase` \| `merge` |
| `ledgerPath` | `## decision ledger` | path template |
| `mergeAuthority` | `## merge authority` | list of `{paths, globs, who, whoRaw, precondition}` |
| `gates` | `## gates` | list of `{name, source: {type, ref}, pass}` |
| `runPolicy` | `## run policy` | `{dayCeiling, maxParallel, fixRounds, ciFix, ceilingExclusions, stopHour, lockedArtefacts, forcePushAfterRebase}` |
| `inviolables` | `## inviolables` | list of strings |
| `ownerProxy` | `## owner proxy` | `{role, mandate, hardStopChannels, hardStopPaths}` or `null` |
| `dayRunAllowed` | `## owner proxy` | boolean |
| `escalation` | `## escalation` | `{doubtLog, human}`; `doubtLog` is an absolute path from `lib/doubt-log.sh resolve`: the `- Doubt log:` field, else `$TILLER_DOUBT_LOG`, else `doubts/<date>.md`; `~` and `<date>` (UTC) expanded, relative paths against the profile's directory |
| `modelRouting` | `## model routing` | `{<lane>: <tier>}`, `{}` for defaults |
| `staticChecks` | `## static checks` | list of `{check, command}`; `n/a` rows left out, `[]` when absent or `none` |
| `worktreeSetup` | `## worktree setup` | list of `{check, command}`, same shape as `staticChecks`; `[]` when absent or `none` |
| `verificationRegister` | `## verification register` | path string, or `null` when absent or `none`; a `TODO` or a Path line with no code span refuses the profile |
| `worktreeCreate` | `## worktree` | command template string, or `null` when absent or `none` |
| `commits` | `## commits` | `{format, ticketFromBranch, withoutTicket}`; absent or `none` renders `{format: "<type>(<scope>): <subject>", ticketFromBranch: null, withoutTicket: "<type>(<scope>): <subject>"}` |

`who` is `agent` \| `human` \| `unconfirmed`; `whoRaw` keeps the cell verbatim and `precondition`
carries the `after …` text or `null`. Model-routing lanes and tiers are checked against
`lib/contract/kinds.json`, and a lane that feeds a gate is never routed below the top tier.

### What a missing fact does

```bash
lib/profile-facts.sh --check [--profile <file>] [dir]   # per-key report; exit 4 means a launch would be refused
lib/profile-facts.sh [--profile <file>] [dir]           # the facts object on stdout, or exit 4 and no output
```

`--profile` reads that file and skips resolution. Every required key is validated before anything
spawns, not only the ones the first phase needs, so an unfilled profile fails at launch where it is
cheap. A field that reads `TODO` counts as unfilled: a draft value a gate trusts is worse than no
value.

What still surfaces mid-run — a fact that is present but false, or a prose section an agent cannot
find — stops the phase that needed it and is recorded as an open decision. **Absence is never a
permission.** Nothing downstream defaults it, no phase infers it from the repository, and a fact
that cannot be read is treated as `unconfirmed`, the strictest option the project has.

The profile is resolved fresh at every start and every resume, never replayed from a run record: an
incomplete profile is unblocked by editing the profile, so the snapshot is per attempt. A run
records which profile and which facts it used.

## The gate evaluator

`lib/gates/evaluate.mjs` turns facts, the PR head, its changed files and the observed gate states
into a `gate-result` (`lib/contract/schemas`). Its functions are dependency-free so a Workflow
script can inline them; the CLI reads one JSON input and prints a `script-result` line.

- **Authority per file.** The row whose matching glob has the most literal characters governs;
  on a tie the stricter row wins. A file no row matches takes the strictest authority in the table,
  never less than `human`. The PR's authority is the strictest over its files, ranked
  `agent` < `human` < `unconfirmed`; every file not `agent` is listed in `humanPaths`.
- **Conditions.** One per declared gate, taken from its observation. A gate with no observation,
  an unreadable state, or an observation on another head is `blocked`. Each unconfirmed
  `agent, after …` precondition touched by the PR adds a `blocked` condition.
- **Outcome.** `mergeAllowed` when authority is `agent` and every condition is green.
  `readyToSign` when authority is not `agent` and every condition is green: the PR stays open on the
  ready-to-sign list for a human. Anything else parks with the red or blocked conditions named.

A project may keep `profiles/<name>/cases.json` — `{"cases": [{"path", "who"}]}` — and
`node --test 'lib/gates/tests/*.test.mjs'` checks the rendered profile against every case.

## Rules that bind a profile

- **Facts, not procedure.** If a line tells the agent *how* to do something, it belongs in the
  skill. A profile answers "what is true here", never "what should you do".
- **A merge rule is copied from its canon, never paraphrased.** The profile links the canonical
  file and reproduces the path table verbatim. A path not in the table takes the strictest option
  in that project, and a project with no rule at all is `unconfirmed`, which means a human merges.
  See `docs/adding-a-project.md`.
- **No secrets.** A profile names where a credential lives, never its value. Values go in
  `profiles/<name>/secrets.env` (mode 600, git-ignored); a profile is the file most likely to be
  pasted into a ticket or shared with another team.
- **Wayfinding is separate from delivery.** `## wayfinding` names the maps repo and the project
  label, never the project's own board. A decision ticket on a delivery board distorts the board and
  carries internal vocabulary into tickets that must not have it. See `wayfinding/README.md`.
- **Every claim is dated.** A profile is a record of the world; the world moves. `(measured YYYY-MM-DD)`
  on anything that could rot — host names, deployed versions, who owns what.
