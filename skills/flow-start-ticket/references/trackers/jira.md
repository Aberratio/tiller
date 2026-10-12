# Tracker kind `jira`

The `jira` binding of the tracker ops `flow-start-ticket` names, through `config/tool-kinds.json`.

| Op | Atlassian MCP tool | Call shape |
|---|---|---|
| `tracker.get` | `getJiraIssue` | `cloudId` = `## tracker` Site, `issueIdOrKey`, `fields` as listed in step 1 (honoured) |
| `tracker.search` | `searchJiraIssuesUsingJql` | JQL over the project key (and `parent = <epic>` when the repo pins one), `resolution = Unresolved`, `ORDER BY priority DESC, Rank ASC`. `fields` is ignored: whole descriptions come back, so keep `maxResults` small |
| `tracker.me` | `atlassianUserInfo` | no arguments; `account_id` is the assignee id |
| `tracker.edit` | `editJiraIssue` | `fields: {assignee: {accountId}}` |
| `tracker.transitions` | `getTransitionsForJiraIssue` | each transition carries `to.name`, the target status |
| `tracker.transition` | `transitionJiraIssue` | `transition: {id}` from the matching entry |
