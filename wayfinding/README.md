# Wayfinding adapter

`/wayfinder` charts a big, foggy effort as a map of decision tickets on "this repo's issue
tracker". It does not implement a tracker — it reads six operations out of the tracker doc:

> Map · Child ticket · Blocking · Frontier query · Claim · Resolve

Three tracker templates ship with `setup-matt-pocock-skills`: GitHub, GitLab, local markdown. None
of them fits a project that tracks its work elsewhere (Jira, say), and a decision ticket is not a
deliverable — putting one on the team's board distorts the board and smuggles internal vocabulary
(`wayfinder:grilling`) into tickets that are supposed to carry none.

So the maps live in **one private GitHub repo**, separate from every project's tracker, named in
each profile's `## wayfinding` section. Project work stays in the project's tracker; only the
*finding of the way* lives in the maps repo, and what survives the map crosses back as an ordinary
ticket.

This directory is the adapter. It is deliberately thin — **the `/wayfinder` skill is not forked**.
It reads the tracker doc it always reads; this just makes sure the doc says something true.

| File | What it is |
|---|---|
| `issue-tracker-section.md` | the `## Wayfinding operations` section, ready to append to a project's `docs/agents/issue-tracker.md` |
| `setup-wayfinding.sh` | creates the maps repo and its five labels; idempotent |
| `README.md` | this |

## Installing it for a project

1. Run `WAYFINDER_MAPS_REPO=<owner>/<repo> setup-wayfinding.sh` once per machine (not per project).
2. Append `issue-tracker-section.md` to that project's `docs/agents/issue-tracker.md`, replacing
   `<PROFILE>` with the project's profile name and `<MAPS_REPO>` with the maps repo.
3. Fill the profile's `## wayfinding` section (it is in `profiles/_template/profile.md`).

Step 2 edits a file inside the project repo. That is on purpose: it is the file `/wayfinder`
actually reads, `docs/agents/` exists for exactly this, and a teammate who runs the skill then gets
the same six operations instead of improvising their own.

## One measured thing that the shipped GitHub template gets wrong

The GitHub template computes the frontier from `issue_dependencies_summary.blocked_by`. **That field
is eventually consistent and lags a write by roughly two to four seconds** (measured 2026-09-14):

```
POST .../dependencies/blocked_by   -> summary.blocked_by = 0   (wrong)
                            +2s    -> 0                        (still wrong)
                            +4s    -> 1                        (right)
```

It lags in the other direction too: immediately after closing a blocker, one dependent still
reported `blocked_by=1` while another already reported `0`.

This matters because charting does **create-then-wire** and then queries the frontier. Reading the
summary in that window hands out a *blocked* ticket as takeable, and nothing downstream catches it —
the session resolves a decision whose input does not exist yet.

**So the frontier never reads the summary field.** It reads
`repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by` and checks each blocker's `state`. That
endpoint was correct on every read, including immediately after both the write and the close.
