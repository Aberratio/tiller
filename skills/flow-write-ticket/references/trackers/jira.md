# Tracker kind `jira`

The `jira` binding of the tracker ops `flow-write-ticket` names. Ops resolve through
`config/tool-kinds.json` (`role:tracker.<op>` → Atlassian MCP tool); the op is given first, the
tool it resolves to in brackets.

## Required fields (step 6)

In parallel where possible. Pass the `## tracker` Site as `cloudId`; the MCP accepts a site host or
a cloud id. It fails → `tracker.sites` (`getAccessibleAtlassianResources`) once and cache the id.

- **Project — validate against the live tracker before offering it.** Call `tracker.projects` (`getVisibleJiraProjects`) once
  and keep the live key list. Each key the profile's routing suggests must be in it: routing tables
  are copied from a written guide and **drift**. A missing key → offer the closest live key by
  project name and say so in one line. **Never pass an unvalidated key to `tracker.create`** (`createJiraIssue`) — it
  fails with "No project could be found". Skip live projects whose name marks them deprecated. The
  profile may record the drift it already knows; re-measure rather than trust it.
- **Issue type.** `tracker.issue-types` (`getJiraProjectIssueTypesMetadata`) for the chosen project. A type may simply not
  exist there: `tracker.create` rejects an unknown type with `allowedValues` in the error body —
  read that list, do not retry blind. With no Question type, file a decision ticket as **Task** whose
  first line says it is a decision, not build work — otherwise someone estimates it (precedent: ABC-231).
- **Component — check the siblings first.** Read what the ticket's siblings actually carry. Being
  the only child of an epic with a Component is a deviation, not tidiness, and it makes board
  filters disagree (every child of ABC-206 had `components: []`). Then follow the profile's
  components rule; "exactly one" means work spanning two surfaces is **two linked tickets**.
- **Priority.** The profile's scheme. Suggest a default from its signals; the user confirms.
- **Assignee.** Only if the user named someone — `tracker.lookup-user` (`lookupJiraAccountId`).
- **Epic.** Only if the user named a parent.

## Cost warning before searching (step 6b)

**`tracker.search` (`searchJiraIssuesUsingJql`) ignores `fields` — it returns full descriptions regardless** (measured: five children of one epic, `summary` and `status` requested, tens of thousands of
characters back, `remainingCount: 55`). Keep duplicate-check JQL narrow — search the keys you
suspect, not `parent = EPIC`. For titles of many keys prefer single `tracker.get` (`getJiraIssue`) calls (`fields` is
honoured there), or the profile's **Board snapshot**, if it names one — mind the coverage it states.

## Create (step 9)

`tracker.create` (`createJiraIssue`) with `cloudId`, `projectKey`, `issueTypeName`, `summary`,
`description`, `components` (per the profile's rule), `priority`, and `assignee` / `parent` when set.
`tracker.link` (`createIssueLink`) takes the link type name and an optional `comment`.

## Update (update mode, steps 2 and 11)

`tracker.get` (`getJiraIssue`) honours `fields`; `tracker.edit` (`editJiraIssue`) takes only the
changed fields.
