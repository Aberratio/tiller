---
name: flow-helm
description: Cross-project overview from the private helm - which project is at which stage, what is next, what is due, what was promised, which machine holds which clone. Use when the user asks what is on across projects, what is due or overdue, for the status of all projects, whether they promised anyone anything, to record a promise or a deadline ("I promised X by Friday", "add this deadline"), to move or close one, to put deadlines in the calendar, to add a project to the helm register, or when a day plan needs the order across projects.
user-invocable: true
---

# flow-helm

Advice only. It names the next step, the skill, the repository and the machine that holds the
clone; it never starts a run, a session or a skill.

Each command is written out in full, because shell state does not persist between Bash calls:
`node "$TILLER_HOME/lib/helm/helm.mjs" <command>`.

## Step −1 — Resolve the project profile (may be absent)

Read `$TILLER_HOME/skills/_shared/resolve-profile.md` and follow its pre-profile variant. Outside a
project no profile resolves and the full view applies; inside one, only the project-scoped
recording below.

## Where it runs

- **Outside any project** (no profile resolves): everything below.
- **Inside a project**: the private-access hook denies every path under `helm/` and every call to
  `helm.mjs`. Only `"$TILLER_HOME/lib/helm/record.sh"` works there, run from the session's own
  directory, for that project. Do not work around a deny; say the full view needs a session
  outside the project.
- Exit 4 from any command: there is no helm. Say `./install.sh --helm <git-url>` (existing helm) or
  `./install.sh --helm --new <git-url>` (first machine) and stop.

## Status

`node "$TILLER_HOME/lib/helm/helm.mjs" status --json`. Report as a numbered list in execution
order: projects with a dated item first by earliest due, then those with a next step by oldest
activity, parked last with the condition for return. Each item: project, stage, next step, and
where to do it (`clones` of each machine; "this machine" first). A project with no clone on this
machine says which machine has one. Machines whose `last_seen` is older than `staleDays` are named
once at the end: their events may be missing.

## Record by hand

- Resolve a relative date ("by Friday") to an absolute date in the helm's `tz`; when it could mean
  two dates, ask with `AskUserQuestion`.
- Inside a project: `"$TILLER_HOME/lib/helm/record.sh" --kind <k> --summary "<s>" [--due <date>] --source manual`.
- Outside: the same with `--project <name>`.
- Kinds: `promise` (to a person, with a due), `deadline` (with a due), `next`, `parked` (summary
  is the condition for return), `note`.
- Move: a new event of the same kind with the new `--due` and `--supersedes <old id>`. Close or
  cancel: `--kind done --supersedes <id>`. Ids come from `status --json`, which runs only outside a
  project, so moving or closing an event is done from a session outside the project, with
  `--project <name>`. Never edit a file in `events/`.

## Register a project

Outside a project only. Add a row to the `## Projects` table of `$TILLER_HOME/helm/helm.md`
(project = the profile name, repos, role, rhythm), then
`git -C "$TILLER_HOME/helm" commit -qam "register <name>" && git -C "$TILLER_HOME/helm" push -q`,
then record `--kind registered --summary "Registered" --project <name>`.

## Calendar

1. `node "$TILLER_HOME/lib/helm/helm.mjs" calendar-pending`. Exit 5: this machine lacks the
   `calendar` capability; name a machine that has it (from `status --json`) and stop.
2. For each line, search the calendar for the event id first. Found: record
   `--project <project> --kind note --summary "In calendar" --calendar-for <id> --link <event url>` (the
   project is on the `calendar-pending` line; calendar work runs outside a project) and move on.
3. Not found: ask with `AskUserQuestion`, one deadline per question, create as the recommended
   option. Only on a yes, create an all-day event on the due date whose description contains
   `helm: <id>`, then record the note as in step 2.
4. A deadline that was moved gets a new proposal; name the old calendar event for the user to move
   or delete. Never delete one.
