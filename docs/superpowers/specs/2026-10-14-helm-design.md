# Helm

## Goal

One private, cross-project overview above the profiles: which project is at which stage, what is
next, what is due and what was promised. It reminds, and it advises; it never acts. The content
lives in a separate private git repository, so tiller stays generic, and the same helm is shared by
every machine that runs tiller.

## Decisions

| Question | Decision |
|---|---|
| Direction of information | Projects write to the helm. The helm reads only its own repository. A project session never reads the helm. |
| Concurrent writers | An append-only event log: one new file per event, never edited. State is derived, not committed. |
| Who writes | Fixed milestones in `flow-*` skills, plus explicit entries on request. |
| Reminders | SessionStart hook, a full status for day planning, calendar events proposed and created only on approval. |
| Autonomy | Advice only. The helm names the next step, the skill and the repository; it starts nothing. |
| Machines | Each machine keeps one file of its own: identity, clones, capabilities, last seen. |
| Attachment | A new kind next to `brains/`, not a brain and not a profile. |

A brain was rejected because a `write` grant also reads the whole vault, so project A would see
project B. A profile was rejected because `_`-prefixed names are templates and skipped by
`list_names`.

## Layout

```
helm/                        local, git-ignored: a clone of the private helm repository
lib/helm/template/           tracked: skeleton of a new helm repository
lib/helm/events.mjs          event format, ids, frontmatter
lib/helm/state.mjs           events -> derived state
lib/helm/due.mjs             state -> overdue, due soon, parked, stale, stranded machines; status order
lib/helm/machine.mjs         this machine's file
lib/helm/helm.mjs            CLI: init, record, session, status, calendar-pending
lib/helm/record.sh           append one event, stamped with the resolved profile
lib/hooks/helm-session.sh    SessionStart: pull, refresh machine, print at most five lines
skills/flow-helm/            status, advise, record by hand, calendar proposals
```

`.gitignore` gains `/helm/`. The template lives in `lib/` because `git clone` refuses a non-empty
target. The leak guard scans only files git would track, so the clone is outside its scope.

### Inside the helm repository

```
helm.md                      owner, time zone, stale threshold in days, project register
events/<UTC>-<machine>-<id>.md
machines/<machine>.md
.cache/                      ignored by the helm repository's own .gitignore
```

`helm.md` register row: project name (the profile name), repository URLs, role, rhythm (e.g.
weekly client call). Only `flow-helm` edits `helm.md`, and only on the machine where the owner asks
for it; a concurrent edit is the one place a merge conflict can occur, and it is accepted.

## Event format

Filename: `<YYYY-MM-DDTHH-MM-SSZ>-<machine>-<6 hex>.md`. Content: YAML frontmatter, optional body.

```yaml
id: 2026-10-14T09-12-40Z-laptop-3f9a1c
project: acme            # from resolve-profile; record.sh refuses an explicit override
kind: deadline           # registered | milestone | next | deadline | promise | parked | done | note
summary: Spec signed off by the client
due: 2026-10-21          # date or datetime, deadline and promise only
supersedes: <id>         # optional: moves, cancels (with kind done) or replaces an earlier event
source: flow-discovery   # skill name or "manual"
link: https://...        # optional
```

Derivation in `state.mjs`, per project: the latest `milestone` is the stage, the latest `next` is
the next step, open `deadline` and `promise` events are those not superseded and not closed by a
`done` that supersedes them, the latest `parked` without a later `done` is a blocker, the newest
event of any kind gives the last activity. Ordering is by the timestamp in the id; ties break on the
id string.

## Writing

`lib/helm/record.sh --kind <k> --summary <s> [--due <d>] [--supersedes <id>] [--link <u>] [--source <s>]`

1. No `helm/` clone: exit 0 silently. Tiller without a helm behaves as today. No profile resolves
   and no `--project` is given: exit 2 with a usage line.
2. The project is the resolved profile. `--project` is accepted only when no profile resolves
   (a session outside any project recording by hand).
3. `git pull --rebase` with a short timeout, write the file, commit, `git push`. A failed pull or
   push leaves the commit local; the next write or session start pushes it. Unique filenames mean
   a rebase never conflicts.

### Milestones in flow skills

One `record.sh` call each, never a gate (a failure is reported, the skill continues):

| Skill | Event |
|---|---|
| `flow-onboard-project` | `registered`, and a row in `helm.md` when the owner confirms |
| `flow-start-ticket` | `milestone` ticket started |
| `flow-create-pull-request` | `milestone` PR opened, with the link |
| `flow-confidence-check` | `milestone` with the verdict |
| `flow-discovery` | `deadline` per dated roadmap phase; `done` superseding it when the phase is met |
| any skill that parks | `parked` with the condition for return |

## Access

`private-access.sh` gains one protected root, `$TILLER_HOME/helm/`:

- A session that resolves a profile: every read and write under `helm/` is denied, Bash included.
  `lib/helm/record.sh` is allowed because the command names the script, not the helm path.
- A session that resolves no profile (`_none`): read allowed; writes allowed only to `helm.md` and
  `machines/`. Events are written only through `record.sh`.

The Known gap of the brains design applies unchanged: a script that builds the path at run time is
not stopped.

## Machines

`machines/<machine>.md`, written only by that machine (`machine.mjs`, run by the SessionStart hook):

```yaml
machine: laptop          # TILLER_MACHINE, else the short hostname, lowercased
last_seen: 2026-10-14    # day precision: at most one commit per machine per day from refreshes
profiles: acme, beta     # profiles/*/profile.md present here
capabilities: gh, calendar
clone.acme: /Users/x/src/acme-web
```

Frontmatter is flat `key: value`; lists are comma-separated. `clone.<project>` is learned, not
configured: a session that starts in a project records the main checkout of that repository
(a worktree resolves to its main checkout), and a clone whose path no longer exists is dropped.
`repo_globs` are match patterns, not paths, so they cannot supply it.

`capabilities`: `gh` when `gh auth status` succeeds; the rest declared in `TILLER_MACHINE_CAPS`
(comma-separated), because connector authorisation is not visible locally.

Unpushed events are invisible to other machines by definition, so the file does not claim them.
The machine that holds them says so itself at session start. Uses:

- Advice names a machine: the next step for a project whose repository is not cloned here says
  where it is cloned.
- Another machine whose `last_seen` is older than the stale threshold is listed as possibly holding
  unshared events; this machine lists its own commits not yet on the remote.
- Calendar proposals are made only on a machine with `calendar`.

## Reminders

### SessionStart

`helm-session.sh`: pull with a two-second timeout (offline: local state, marked `offline`), refresh
this machine's file, render state, print at most five lines in this order: overdue, due within
48 hours, parked, stale projects, stranded machines. Nothing to report prints nothing. The hook
runs in every session; in a project session it prints only that project's lines, because the full
list would leak other projects into it.

### Status

`flow-helm status` (also read by a day-planning skill): every project with stage, next step, open
deadlines and promises, blocker, last activity, and the machine that holds its clone. Ordered by
hard deadline, then what unblocks most, then the rest; parked last with the return condition.

### Calendar

`flow-helm calendar`: for each open `deadline` without a calendar marker, propose an event. Each
creation needs the owner's approval in that turn. The event description carries the helm event id;
before proposing, existing events are searched for that id, so a second machine does not duplicate
it. A created event is recorded as a `note` with `calendar_for: <deadline id>` and the calendar
link; that note is the marker. A `deadline` superseded later gets a fresh proposal, and the old
calendar event is named for the owner to move or delete.

## Onboarding

`install.sh --helm <git-url>`: clone into `helm/`. With `--helm --new <git-url>`: initialise from
`lib/helm/template/`, set the remote, push the first commit. Both then refresh this machine's file; `install.sh --hooks` prints the
SessionStart fragment for `~/.claude/settings.json` (the file is not edited). `TILLER_MACHINE`
should be set in `settings.json` `env` when the hostname is not stable.

## Testing

Fixtures in `lib/testing/`: a bare repository and two clones acting as two machines, one fixture
profile per clone.

- Parallel `record.sh` on both clones, then sync both: no conflict, both events present on both.
- Push failure: the event stays local, this machine reports it at session start, the next write pushes it.
- Derivation: a `deadline` moved by `supersedes`, closed by `done`; `parked` cleared by `done`;
  ordering on equal timestamps.
- `due.mjs`: overdue, 48-hour window across a time zone boundary, stale threshold, stranded machine.
- `record.sh` in a project session refuses `--project`; without a helm it exits 0 with no output.
- Hook: a project session is denied Read, Grep, Glob and Bash under `helm/`; `record.sh` passes;
  a `_none` session reads, writes its own machine file, and is denied an event write.
- SessionStart in a project session prints only that project's lines.

## Out of scope

- Starting runs or sessions from the helm.
- Reading boards, profiles or repositories of projects from the helm.
- A push notification routine outside a session.
- Editing `~/.claude/settings.json` automatically.
