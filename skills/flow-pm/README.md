# flow-pm

The board role. It reconciles each ticket's status against the artefact that proves it (branch, PR,
merge, verification record), moves the ones that drifted within the profile's `## board` mandate,
measures whether every "is blocked by" relation still holds, writes a dated board snapshot, and builds
a deadline radar from the sources that actually carry dates.

It can be consumed by a morning day-planning step (`sweep`), an end-of-day note step (`close`) or a
day orchestrator such as `flow-run-day` (reads the snapshot). None of them is required.

## Usage

```
/flow-pm                 # sweep
/flow-pm audit           # report what would change, write nothing
"is the board accurate?"
```

## Requirements

- A profile with `## tracker` and, for any write, `## board` (`docs/profile-schema.md` → Board).
- `gh`, `git`, `jq`.
- Tools, least privilege — the whole allowlist of the source agent:
  - `Bash`, `Read`, `Grep`, `Glob`, `ToolSearch`
  - tracker: `searchJiraIssuesUsingJql`, `getJiraIssue`, `getTransitionsForJiraIssue`,
    `transitionJiraIssue`, `editJiraIssue`, `getJiraIssueRemoteIssueLinks`
  - calendar (read): `list_events`, `search_events`
  - chat (read): `slack_search_public_and_private`, `slack_read_thread`
  - docs (read): `notion-search`, `notion-fetch`
  - No `Write`/`Edit`: the log and snapshot are written through Bash.
- A mid-tier model is enough: the lane is read-heavy and every judgement is a table lookup.

## Tests

`tests/run-tests.sh` pins `scripts/blocker-facts.sh`: no canary is a usage error; the instrument check
(canary absent, canary not done, extra keys, empty status category) issues no verdict; `never` vs
`stale` vs `open`; `emit` writes `unknown` with no timestamp on a failed instrument and never carries
the previous verdict forward. The `## board` section is pinned in `lib/gates/tests/profile-facts.test.mjs`.

## Rules earned in field use

Each rule below was added after a sweep went wrong without it.

- A status change needs an artefact; full mandate on the owner's tickets
- Never read the tracker response whole; `jq` over the spilled file
- Unbounded open-PR list per repo plus key search
- Read the description before "no artefact" (split tickets keep the old key)
- Assignee query is not the whole list; unassigned + owner's PR = owner's
- Backwards drift first
- Merged PR can be the artefact for a slice only
- One `##` header per run; no revert line for a no-op; changelog author not trusted
- Transitions fetched before every move
- Never write `duedate`; radar from several sources
- Open the chat thread before raising a promise
- Stalled after 3 working days
- WIP limit is the owner's number
- `blockedBy` is a measurement; `unknown` + `measuredAt: null` when not measured
- Blocker check at all (the morning half of the blocker gate)
- `statusCategory.key`, never `resolutiondate`; no `fields` on the check's JQL
- `never` split from `stale` by status name
- Instrument check (canary + exact key set) before any verdict
- Step 0 instrument inventory
- No snapshot in `close`

## Design notes

- Every project fact - site, project keys, repos, the owner's chat handle, epics, status names, the
  canary - comes from `## tracker` and `## board`; the script has no default canary, because a foreign
  canary is absent from every read and fails every run.
- Transition ids are never cached: they are per workflow, and the rules already require fetching them.
- Report headings are English; a consumer that wants another language maps them.
- Day-planning and end-of-day steps are optional consumers, never requirements.
- Writes are the closed `Writes` list, and every outward channel is a hard stop.
