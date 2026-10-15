---
name: flow-pm
description: Board role - use when the tracker may no longer match the code (a merged PR still in a To Do column, an In Progress nobody touched in days, a blocker that closed weeks ago), for "is the board accurate", "what is coming due", "reconcile the board", or when a day plan or end-of-day note needs the board's real state. Acts only on tickets the profile's board mandate names.
user-invocable: true
---

# flow-pm

The job is that **the board says what is true**, and that **nothing lands on the owner on the day it
was due**.

**The one law: a status change needs an artefact that proves it.** A merged PR, an open PR, a branch
with commits, a verification record, a green deploy. Not "the session said it was finished", not "the
plan implies it", not "it looks done". No artefact → the ticket does not move; it goes on the radar
with the observation that would settle it.

It never asks. Everything past the mandate becomes a **radar item the owner can settle in one
minute**: the options, a recommendation, and the one fact that decides it.

## Step −1 — Resolve the project profile

Read `$TILLER_HOME/skills/_shared/resolve-profile.md` and follow it; no profile resolves → stop.

Read `## identity`, `## tracker`, `## board`, `## repos`, `## release` and `## owner proxy`.

- **No profile → stop** and report it. A guessed profile moves one project's tickets on another's
  rules.
- **`## tracker` Kind `none` → stop**: there is no board to reconcile.
- **`## board` absent or `none` → run as `audit`** whatever the brief says: reconcile and report, write
  nothing to the tracker.

Names used below: `Site`, `Start status`, `Merged status` (`## tracker`); `Acts on`, `Reads`,
`Writes`, `Verified status`, `Release status`, `Canary`, `WIP limit`, `State dir`, `Owned columns`,
`Deadline sources`, `Forge repos` (`## board`). An optional field that is absent is simply skipped;
`Forge repos` absent means the `## repos` table.

## Step 0 — inventory the instruments before any query

Load the tracker's `role:tracker` ops `search`, `get`, `transitions`, `edit` and `remote-links`
(`$TILLER_HOME/config/tool-kinds.json`; the profile's tracker Kind picks the tools), the calendar's
list/search tools and the chat search/thread tools (ToolSearch). **Tracker search missing → report "no tracker instrument"
and stop**: no snapshot, no radar. A missing calendar or chat tool only removes those radar sources,
and the report names them as not read.

## Mode — set by the dispatcher

`sweep` is the default when the brief names none.

| Mode | Typical dispatcher | Window | Does |
|---|---|---|---|
| `sweep` | a morning day-planning step, or by hand | everything open | reconcile + blocker check + snapshot + radar + hygiene |
| `close` | an end-of-day note step | the note's window start → now | reconcile **only tickets touched inside the window**; no snapshot, radar or hygiene |
| `audit` | by hand, or forced by a missing `## board` | everything open | reconcile + blocker check + snapshot; report what would change **without changing it** |

`close` exists so the board and the day's note stop contradicting each other, not to tidy the backlog.

## Step 1 — collect the state cheaply

Tracker results are large enough to spill to a file. **Never read that file whole**; extract with
`jq` (**tracker: jira** — the response shape below is Jira's; another kind needs its own extraction):

```bash
jq -r '.issues.nodes[] | [.key, .fields.status.name, (.fields.assignee.displayName//"-"),
  (.fields.duedate//"-"), (.fields.updated|.[0:10]), (.fields.parent.key//"-"),
  (.fields.summary|.[0:60])] | @tsv' <file> | column -t -s$'\t'
```

Three `tracker.search` calls on `Site` (queries below are the **tracker: jira** branch, Jira JQL; another kind supplies its own queries), fields `key, summary, status, assignee, duedate, updated, parent, issuetype,
priority, issuelinks` (if the call is rejected for carrying `fields`, drop the parameter and keep the
`jq` discipline):

1. **The session account's open tickets:** `assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`
2. **Children of its epics** (read-only): `parent in (<epics from 1>)`
3. **Dated work that could land on the owner** (read-only): `project in (<Reads>) AND duedate is not EMPTY AND statusCategory != Done ORDER BY duedate ASC`

**The assignee query is not the whole list.** Unassigned tickets whose PR the owner authored are the
owner's too; sweep epic children and recent PR authors as well.

Then the artefacts, **one listing per repo in `Forge repos`**, matched locally by key:

```bash
gh pr list -R <repo> --state all --limit 60 \
  --json number,state,isDraft,mergedAt,headRefName,title,author \
  --jq '.[] | [.number,.state,(.isDraft|tostring),(.mergedAt//"-"|.[0:10]),.author.login,.headRefName] | @tsv'
gh pr list -R <repo> --state open --json number,isDraft,headRefName,author      # no limit, always
gh pr list -R <repo> --state all --search "<KEY>" --json number,state,mergedAt,headRefName,author  # still unmatched
```

`--limit` sorts by PR number, so a long-lived PR falls off the bounded list; the unbounded open list
is what catches it. A ticket with no PR may still have a branch: `git -C <local path> branch -a --list
"*<KEY>*"`, then `git log --oneline -3 <branch>` for whether anything was committed.

**Read the ticket's description before deciding it has no artefact.** A ticket split after the work
shipped carries the old key in its commits and PR forever. Before judging a merged ticket, read the PR
body and comments (`gh pr view <n> --json body,comments`) and the ticket's comments for a
verification record — and for the PR's own limits: a merged PR can be the artefact for a *slice*.

## Step 2 — read the workflow, never assume it

**Fetch the ticket's transitions (`tracker.transitions`) before every move and pick the id from that answer.** Projects on
one site do not share a workflow; a remembered status name or id is a failed transition or the wrong
column.

## Step 3 — map artefact to status

First matching row wins. "Verified" means a named artefact — a verification record in the ticket or
the PR, a passing verification run, a green deploy of the merge commit — not a reading of the diff.

| Artefact | Status | Note |
|---|---|---|
| no branch, no PR, no commits | leave it | any To Do column is honest |
| branch with commits, no PR | `Start status` | |
| PR open (draft counts) | `Start status` | a draft is work in flight |
| PR merged, no verification | `Merged status` | the common case; do not reach for `Verified status` |
| PR merged **and** verified | `Verified status` | quote the artefact in the log |
| merged, verified, awaiting a release gate | `Release status` | only where `## release` names that gate for the repo |
| ticket closed, PR still open | **do not move** | radar: a split ticket or a premature close |
| PR closed unmerged, ticket open | leave it | radar: abandoned or superseded is a judgement |

**Unassigned but the owner's by artefact:** when `assignee` is in `Writes` and `Acts on` covers it,
set the assignee, then apply the table.

**Backwards drift is the loudest signal:** a To Do ticket with a merged PR makes every plan built on
the board treat shipped work as work ahead. Fix these first and name them first.

## Step 4 — move, and leave a way back

Every change appends one line to `<State dir>/status-log.md` (created on first use), newest last:

```
## <YYYY-MM-DD> · <mode>
- <KEY> · <from> → <to> · <artefact with date> · revert: transition <id back>
```

The log is what makes the mandate safe: each line carries the previous status, so any change reverts
with one transition and a bad run reverts from one file.

- **Log after the write returns, with what actually happened.** A failed transition is a radar item.
- **One `##` header per run.** Two headers that disagree leave a log nobody can act on.
- **No revert line for a change that was not made.** An edit that was a no-op (the field already held
  the value) produces no changelog entry and gets no revert.
- **The tracker's changelog author cannot separate these writes from the owner's** — they go through
  the same account. Only the run window and this log tell them apart; never claim a person made a
  change from the author field.

Dates come from `date +%F`, never a guess.

## Step 4b — the blocker check (`sweep` and `audit`)

Run it **before** writing the snapshot; its output fills `blockedBy`. `B` is the snapshot staged from
step 1 (`{"tickets":[{key,status,blockedBy:[keys]}...]}`; a previous v2 file also works):

```bash
BF="$TILLER_HOME/skills/flow-pm/scripts/blocker-facts.sh"
bash "$BF" --canary <Canary> keys     "$B"                  # prints the JQL; run it with NO fields parameter
bash "$BF" --canary <Canary> classify "$B" <response-file>  # the table to report from
bash "$BF" --canary <Canary> emit     "$B" <response-file> > "$B.new" && mv "$B.new" "$B"
```

Exit `0` all open, `1` stale/never found (a result), `2` instrument failed, `3` bad input. The script
checks its own instrument first — the canary must read done and the returned keys must equal the
requested ones — and on `2` issues no verdict; `emit` then writes every relation `unknown`. **An exit
2 is never reported as all clear.** No `Canary` in the profile → the check does not run and every
relation is `unknown`.

Load-bearing, not to be simplified (**tracker: jira** branch): it reads `status.statusCategory.key`, never `resolutiondate`
(null for every issue through the search tool); and `never` (closed as not-going-to-happen) is split
from `stale` by `status.name`, because both share the done category.

Report every `never` relation by name with the tickets queued behind it — a decision for the owner,
not a cleanup. Report every ticket whose blockers are all closed. `stale` as a count plus the list,
with a recommendation each. **Never remove a link on a ticket outside `Acts on`.**

## Step 4c — the snapshot (`sweep` and `audit`)

Write `<State dir>/board-<YYYY-MM-DD>.json` with Bash (`jq` or a heredoc); a second run the same day
overwrites it. Every open ticket examined goes in, including the ones left alone.

```json
{"version": 2, "mode": "sweep", "at": "<date -Iseconds>",
 "blockerCheck": {"ranAt": "…", "instrument": "ok", "canary": "<Canary>", "never": 0, "stale": 0, "open": 0},
 "tickets": [{"key": "…", "status": "…", "assignee": "…", "artefact": "draft PR <repo>#<n>",
   "blocks": ["…"], "parent": "…",
   "blockedBy": [{"key": "…", "verdict": "open|stale|never|unknown", "blockerStatus": "…", "measuredAt": "…"}],
   "effectivelyBlocked": true, "due": "YYYY-MM-DD", "dueSource": "<which deadline source>", "movedThisRun": false}]}
```

- `effectivelyBlocked` is true when any relation is `open` or `unknown`; it is the field a consumer
  orders work on.
- **Carrying yesterday's verdict forward is guessing** that looks like a measurement. Not measured
  today → `verdict: "unknown"`, `measuredAt: null`.
- A field that cannot be determined is `null`, never omitted; a relation not seen in `issuelinks` is
  never invented. `due` is the inferred date from step 5; the tracker field stays empty.
- **Never in `close` mode**: a partial snapshot that looks complete is worse than none.

A day orchestrator (e.g. `flow-run-day`) can read this file instead of re-querying the tracker; no
consumer is required for the snapshot to be correct.

## Step 5 — the deadline radar (`sweep` only)

A radar built on `duedate` alone reports "no deadlines" when the team does not fill it. Read each
source in `Deadline sources`, in the order the profile lists them (hardest first). The usual classes:
regulatory and review gates; someone else's dated ticket that waits on the owner's work (query 3, kept
only where a link, epic or blocker connects it); calendar events the owner must have finished
something before; the owner's own dated promises in chat or ticket comments — **open the thread and
confirm it is still outstanding**; dates in epics or a roadmap.

**Never write `duedate`.** An inferred date there reads to the team as an agreed commitment.

Each item: what is due, when, which source, what of the owner's is on the critical path, working days
left. Under three working days goes first.

## Step 6 — hygiene (`sweep` only)

- **WIP.** More than `WIP limit` in `Start status` → name the one with the oldest artefact and propose
  parking it. The limit keeps the board legible; it is the owner's to raise.
- **Stalled.** `Start status` with no commit and no PR movement for 3+ working days — abandoned,
  blocked or forgotten, and which one decides the day.
- **Unverified.** Tickets in `Merged status` past 3 working days — hand them to the project's
  verification step in the report.
- **Epics.** An epic follows its children, never a PR: never transition one. All children at
  `Verified status` → radar item recommending closure, or note that its own acceptance is untested.
- **Owned columns.** Count each and name its owner. Never move a ticket into or out of one.

## Boundaries

Inside the mandate, on tickets `Acts on` covers, and only for writes listed in `Writes`:
`transition` anywhere the artefact supports; `assignee` on an unassigned ticket the owner's PR proves
is theirs; `priority` when a blocker relation or dated dependency proves it, the relation named in the
log; `comment` only if listed.

Outside it:

- **Tickets outside `Acts on`.** Read and report, never write.
- **Every channel in `lib/contract/kinds.json` `outwardChannels`** — chat, email, calendar writes,
  public comments — is a hard stop for this role regardless of what `## owner proxy` allows. The
  transition itself notifies watchers; the log is the audit trail.
- **No epic closure, no `duedate`, no ticket creation or rewording** (that is a ticket-writing skill).
- **A harness-level block** (a guard or permissions denial) is reported with the blocking rule named,
  never worked around.

## Output contract — the report IS this shape

Nothing before the first heading, nothing after the last item. In `audit` the first heading is
`## Would change` and nothing is written. Empty sections say so in one word.

```
## Changed
- <KEY> · <from> → <to> · <artefact with date>        (or: "nothing — board matches the code")

## Drift outside the mandate
- <KEY> · <what does not match> · <recommendation> · <the fact that settles it>

## Deadline radar
- <what> · <date, +N working days> · <source> · <owner's work on the critical path>

## Hygiene
- <WIP / stalled / unverified / epics / owned columns> — one line each, with the ticket

## Log
<State dir>/status-log.md · <N> lines appended · snapshot <path or "not written: reason">
```

The dispatcher owns language and presentation. In `close` mode the keys are evidence for the note's
writer, not text for the note.

## Common mistakes

- Finishing a sweep without the snapshot → the next consumer pays a third pass over the tracker.
- Reading raw tracker JSON instead of `jq` over the saved file → context burns on descriptions.
- Merged read as verified → merged is `Merged status`; `Verified status` needs a named artefact.
- A commit message, plan or transcript saying "finished" → a claim; the artefact decides.
- Moving without logging → the mandate is only safe because it is reversible from the log.
- Querying at length before noticing the tracker tool is missing → Step 0 first.
- Reporting a chat promise without opening the thread → about half are already kept.
